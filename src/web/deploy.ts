import { createHash } from 'crypto';
import cliProgress from 'cli-progress';
import fs from 'fs';
import mime from 'mime-types';
import fetch from 'node-fetch';
import path from 'path';
import pLimit from 'p-limit';
import {
  DnsRouter,
  SiteDeployRequest,
  SiteUploadRequest,
  SiteUploadResponse,
} from '@curvenote/blocks';
import { SiteConfig } from '../config/types';
import { Logger } from '../logging';
import { ISession } from '../session';
import { publicPath, serverPath, tic } from '../utils';

type FromTo = {
  from: string;
  to: string;
};

function listConfig(session: ISession, siteConfig: SiteConfig): FromTo[] {
  const paths: FromTo[] = [];
  paths.push({
    from: path.join(serverPath(session), 'app', 'config.json'),
    to: 'config.json',
  });
  if (siteConfig.logo) {
    const logo = path.basename(siteConfig.logo);
    paths.push({
      from: path.join(serverPath(session), 'public', logo),
      to: `public/${logo}`,
    });
  }
  if (siteConfig.favicon) {
    const favicon = path.basename(siteConfig.favicon);
    paths.push({
      from: path.join(serverPath(session), 'public', favicon),
      to: `public/${favicon}`,
    });
  }
  // Load all static action resources
  siteConfig.actions.forEach((action) => {
    if (!action.static) return;
    // String leading slash
    const names = action.url.split('/').filter((s) => s);
    paths.push({
      from: path.join(serverPath(session), 'public', ...names),
      to: `public/${names.join('/')}`,
    });
  });
  return paths;
}

function listContentFolders(session: ISession): FromTo[] {
  const contentFolder = path.join(serverPath(session), 'app', 'content');
  const folders = fs.readdirSync(contentFolder);
  const fromTo = folders.map((folderName) => {
    const basePath = path.join(contentFolder, folderName);
    const files = fs.readdirSync(basePath);
    return files.map((f) => ({
      from: path.join(basePath, f),
      to: `content/${folderName}/${f}`,
    }));
  });
  return fromTo.flat();
}

function listPublic(session: ISession): FromTo[] {
  const staticFolder = path.join(publicPath(session), '_static');
  if (!fs.existsSync(staticFolder)) return [];
  const assets = fs.readdirSync(staticFolder);
  const fromTo = assets.map((assetName) => {
    return {
      from: path.join(staticFolder, assetName),
      to: `public/_static/${assetName}`,
    };
  });
  return fromTo.flat();
}

async function prepareFileForUpload(from: string, to: string): Promise<FileInfo> {
  const content = fs.readFileSync(from).toString();
  const stats = fs.statSync(from);
  const md5 = createHash('md5').update(content).digest('hex');
  const contentType = mime.lookup(path.extname(from));
  if (!contentType) throw new Error(`Unknown mime type for file ${from}`);
  return { from, to, md5, size: stats.size, contentType };
}

type FileInfo = {
  from: string;
  to: string;
  md5: string;
  size: number;
  contentType: string;
};

type FileUpload = FileInfo & {
  bucket: string;
  signedUrl: string;
};

async function uploadFile(log: Logger, upload: FileUpload) {
  const toc = tic();
  log.debug(`Starting upload of ${upload.from}`);
  const resumableSession = await fetch(upload.signedUrl, {
    method: 'POST',
    headers: {
      'x-goog-resumable': 'start',
      'content-type': upload.contentType,
    },
  });
  // Endpoint to which we should upload the file
  const location = resumableSession.headers.get('location') as string;

  // we are not resuming! is we want resumable uploads we need to implement
  // or use something other than fetch here that supports resuming
  const readStream = fs.createReadStream(upload.from);
  const uploadResponse = await fetch(location, {
    method: 'PUT',
    headers: {
      'Content-length': `${upload.size}`,
    },
    body: readStream,
  });

  if (!uploadResponse.ok) {
    log.error(`Upload failed for ${upload.from}`);
  }

  log.debug(toc(`Finished upload of ${upload.from} in %s.`));
}

export async function deployContent(session: ISession, siteConfig: SiteConfig) {
  const configFiles = listConfig(session, siteConfig);
  const contentFiles = listContentFolders(session);
  const imagesFiles = listPublic(session);
  const filesToUpload = [...configFiles, ...imagesFiles, ...contentFiles];

  const files = await Promise.all(
    filesToUpload.map(({ from, to }) => prepareFileForUpload(from, to)),
  );

  const uploadRequest: SiteUploadRequest = {
    files: files.map(({ md5, size, contentType, to }) => ({
      path: to,
      content_type: contentType,
      md5,
      size,
    })),
  };
  const { json: uploadTargets } = await session.post<SiteUploadResponse>(
    '/sites/upload',
    uploadRequest,
  );

  // Only upload N files at a time
  const limit = pLimit(10);
  const bar1 = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
  session.log.info(`☁️  Uploading ${files.length} files`);
  bar1.start(files.length, 0);
  let current = 0;
  const toc = tic();
  await Promise.all(
    files.map((file) =>
      limit(async () => {
        const upload = uploadTargets.files[file.to];
        await uploadFile(session.log, {
          bucket: uploadTargets.bucket,
          from: file.from,
          to: upload.path,
          md5: file.md5,
          size: file.size,
          contentType: file.contentType,
          signedUrl: upload.signed_url,
        });
        current += 1;
        bar1.update(current);
      }),
    ),
  );
  bar1.stop();
  session.log.info(toc(`☁️  Uploaded ${files.length} files in %s.`));

  const cdnKey = uploadTargets.id;

  const deployRequest: SiteDeployRequest = {
    id: cdnKey,
    files: files.map(({ to }) => ({ path: to })),
  };
  const deploy = await session.post('/sites/deploy', deployRequest);

  if (deploy.ok) {
    session.log.info(toc(`🚀 Deployed ${files.length} files in %s.`));
  } else {
    throw new Error('Deployment failed: Please contact support@curvenote.com!');
  }

  const sites = (
    await Promise.all(
      siteConfig.domains.map(async (domain) => {
        const resp = await session.post<DnsRouter>('/sites/router', {
          cdn: cdnKey,
          domain,
        });
        if (resp.ok) return resp.json;
        session.log.error(
          `Error promoting site: https://${domain}. Please ensure you have permission or contact support@curvenote.com`,
        );
        return null;
      }),
    )
  ).filter((s): s is DnsRouter => !!s);

  const allSites = sites.map((s) => `https://${s.id}`).join('\n  - ');
  if (allSites.length > 0) {
    session.log.info(
      toc(
        `🌍 Site promoted to ${sites.length} domain${
          sites.length > 1 ? 's' : ''
        } in %s:\n\n  - ${allSites}`,
      ),
    );
  }
  session.log.debug(`CDN key: ${cdnKey}`);
  session.log.info(
    '\n\n⚠️  https://curve.space is still in alpha. Please ensure you have a copy of your content locally.',
  );
}
