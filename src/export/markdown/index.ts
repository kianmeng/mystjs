import { GenericNode } from 'mystjs';
import path from 'path';
import YAML from 'yaml';
import { VersionId, KINDS, oxaLink, Blocks } from '@curvenote/blocks';
import { createId, toMyst } from '@curvenote/schema';
import { prepareToWrite } from '../../frontmatter';
import {
  pageFrontmatterFromDTO,
  projectFrontmatterFromDTO,
  saveAffiliations,
} from '../../frontmatter/api';
import { fillPageFrontmatter } from '../../frontmatter/validators';
import { Block, Project, Version } from '../../models';
import { ISession } from '../../session/types';
import { writeFileToFolder } from '../../utils';
import { exportFromOxaLink } from '../utils/exportWrapper';
import { getChildren } from '../utils/getChildren';
import { localizationOptions } from '../utils/localizationOptions';
import { walkArticle } from '../utils/walkArticle';
import { writeBibtex } from '../utils/writeBibtex';
import { writeImagesToFiles } from '../utils/writeImagesToFiles';

export type MarkdownExportOptions = {
  path?: string;
  filename: string;
  images?: string;
  writeBibtex?: boolean;
  bibtex?: string;
  renderReferences?: boolean;
  titleOnlyInFrontmatter?: boolean;
  ignoreProjectFrontmatter?: boolean;
  keepOutputs?: boolean;
};

/**
 * Pull content from a version of kind Output, cache in mdast snippets, and return {mdast} directive
 *
 * This slightly restructures the notebook output from:
 *
 * [
 *   {
 *     "execution_count": 7,
 *     "output_type": "execute_result",
 *     "data": {
 *       "text/html": "...",
 *       ...
 *     }
 *   },
 *   ...
 * ]
 *
 * to
 *
 * [
 *   {
 *     "execution_count": 7,
 *     "output_type": "execute_result",
 *     "data": {
 *       "text/html": {
 *         "content": "...",
 *         "content_type": "text/html"
 *       },
 *       ...
 *     }
 *   },
 *   ...
 * ]
 *
 */
async function createOutputSnippet(
  version: Version,
  name: string,
  mdastSnippets: Record<string, GenericNode<Record<string, any>>>,
) {
  const response = await fetch(version.data.links.download);
  if (!response.ok) return '';
  const outputData = (await response.json()) as Record<string, any>[];
  // TODO: It would be nice if we could consume the notebook output structure as-is.
  outputData.forEach((outputEntry) => {
    Object.keys(outputEntry.data).forEach((content_type) => {
      const outputContent = outputEntry.data[content_type];
      if (typeof outputContent === 'string') {
        outputEntry.data[content_type] = {
          content_type,
          content: outputContent,
        };
      }
    });
  });
  const snippetId = `${name}#${createId()}`;
  mdastSnippets[snippetId] = {
    type: 'output',
    data: outputData,
  };
  return `\`\`\`{mdast} ${snippetId}\n\`\`\``;
}

export async function articleToMarkdown(
  session: ISession,
  versionId: VersionId,
  opts: MarkdownExportOptions,
) {
  const [block, version] = await Promise.all([
    new Block(session, versionId).get(),
    new Version<Blocks.Article>(session, versionId).get(),
    getChildren(session, versionId),
  ]);
  const { data } = version;
  if (data.kind !== KINDS.Article) throw new Error('Not an article');
  const article = await walkArticle(session, data);

  const imageFilenames = await writeImagesToFiles(session.log, article.images, {
    buildPath: opts?.path,
    basePath: opts?.images ?? 'images',
    simple: true,
  });
  const localization = localizationOptions(session, imageFilenames, article.references);
  const mdastName = `${opts.filename.replace(/\.md$/, '')}.mdast.json`;
  const articleMdastSnippets = {};
  const content = await Promise.all(
    article.children.map(async (child) => {
      if (!child.version) return '';
      const blockData = { oxa: oxaLink('', child.version.id) };
      let md = '';
      let mdastSnippets: Record<string, GenericNode<Record<string, any>>> = {};
      if (child.state) {
        const myst = toMyst(child.state.doc, {
          ...localization,
          renderers: { iframe: 'myst' },
          createMdastImportId() {
            return `${mdastName}#${createId()}`;
          },
        });
        md = myst.content;
        mdastSnippets = myst.mdastSnippets;
      }
      if (opts.keepOutputs && !md && child.version.data.kind === KINDS.Output) {
        md = await createOutputSnippet(child.version, mdastName, mdastSnippets);
      }
      if (Object.keys(mdastSnippets).length) {
        Object.assign(articleMdastSnippets, mdastSnippets);
      }
      return `+++ ${JSON.stringify(blockData)}\n\n${md}`;
    }),
  );

  const project = await new Project(session, block.id.project).get();
  saveAffiliations(session, project.data);
  let frontmatter = pageFrontmatterFromDTO(session, block.data, version.data.date);
  if (!opts.ignoreProjectFrontmatter) {
    const projectFrontmatter = projectFrontmatterFromDTO(session, project.data);
    frontmatter = fillPageFrontmatter(frontmatter, projectFrontmatter);
  }
  const metadata = YAML.stringify(prepareToWrite(frontmatter));
  let titleString = `---\n${metadata}---\n\n`;
  if (!opts.titleOnlyInFrontmatter) {
    // TODO: Remove the title when Jupyter Book allows title to be defined in the yaml.
    // https://github.com/executablebooks/MyST-Parser/pull/492
    titleString += `# ${block.data.title}\n\n`;
  }
  let file = titleString + content.join('\n\n');
  if (opts.renderReferences && Object.keys(article.references).length > 0) {
    file += '\n\n### References\n\n```{bibliography}\n:filter: docname in docnames\n```';
  }
  file += '\n\n';
  writeFileToFolder(opts, file);
  if (Object.keys(articleMdastSnippets).length) {
    const normalizedSnippets = Object.fromEntries(
      Object.entries(articleMdastSnippets).map(([k, v]) => [k.split('#')[1], v]),
    );
    writeFileToFolder(
      { ...opts, filename: mdastName },
      JSON.stringify(normalizedSnippets, null, 2),
    );
  }

  if (opts.writeBibtex ?? true) {
    session.log.debug('Writing bib file...');
    // Write out the references
    await writeBibtex(session, article.references, opts?.bibtex ?? 'main.bib', {
      path: path.join(opts.path || '', path.dirname(opts.filename)),
      alwaysWriteFile: false,
    });
  }

  return article;
}

export const oxaLinkToMarkdown = exportFromOxaLink(articleToMarkdown);
