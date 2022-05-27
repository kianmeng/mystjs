import path from 'path';
import YAML from 'yaml';
import { VersionId, KINDS, oxaLink, formatDate, Blocks } from '@curvenote/blocks';
import { createId, toMyst } from '@curvenote/schema';
import { Block, Project, Version } from '../../models';
import { ISession } from '../../session/types';
import { writeFileToFolder } from '../../utils';
import { exportFromOxaLink } from '../utils/exportWrapper';
import { getChildren } from '../utils/getChildren';
import { localizationOptions } from '../utils/localizationOptions';
import { walkArticle } from '../utils/walkArticle';
import { writeBibtex } from '../utils/writeBibtex';
import { writeImagesToFiles } from '../utils/writeImagesToFiles';

type Options = {
  path?: string;
  filename: string;
  images?: string;
  writeBibtex?: boolean;
  bibtex?: string;
  renderReferences?: boolean;
  titleOnlyInFrontmatter?: boolean;
};

export async function createFrontmatter(
  session: ISession,
  block: Block,
  version: Version<Blocks.Article | Blocks.Notebook>,
) {
  const project = await new Project(session, block.id.project).get();
  const { affiliations } = project.data;
  const authorsData = block.data.authors ?? project.data.authors;
  const authors = !authorsData
    ? undefined
    : authorsData.map((author) => {
        const authorAffiliations = author.affiliations
          .map((id) => affiliations.find(({ id: aid }) => id === aid)?.text || null)
          .filter((a) => a);
        return {
          name: author.name || '',
          userId: author.userId || undefined,
          orcid: author.orcid || undefined,
          corresponding: author.corresponding || undefined,
          email: author.email || undefined,
          roles: author.roles?.length > 0 ? author.roles : undefined,
          affiliations: authorAffiliations?.length > 0 ? authorAffiliations : undefined,
        };
      });
  return {
    title: block.data.title,
    description: block.data.description || '',
    date: formatDate('date' in version.data ? version.data.date : version.data.date_created),
    authors,
    name: block.data.name,
    oxa: oxaLink('', block.id),
  };
}

export async function articleToMarkdown(session: ISession, versionId: VersionId, opts: Options) {
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
  const content = article.children.map((child) => {
    if (!child.version || !child.state) return '';
    const blockData = { oxa: oxaLink('', child.version.id) };
    const { content: md, mdastSnippets } = toMyst(child.state.doc, {
      ...localization,
      renderers: { iframe: 'myst' },
      createMdastImportId() {
        return `${mdastName}#${createId()}`;
      },
    });
    if (Object.keys(mdastSnippets).length) {
      Object.assign(articleMdastSnippets, mdastSnippets);
    }
    return `+++ ${JSON.stringify(blockData)}\n\n${md}`;
  });

  const frontmatter = await createFrontmatter(session, block, version);
  const metadata = YAML.stringify(frontmatter);
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
