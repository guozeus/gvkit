import { App, getFrontMatterInfo, parseYaml, TFile } from 'obsidian';
import { createGvid, hasOwnGvid, insertGvidPreservingSource, isTargetMarkdownPath } from './fileIdCore';

const SCAN_YIELD_EVERY = 250;
const WRITE_YIELD_EVERY = 50;

export interface FileIdFailure {
	file: TFile;
	error: unknown;
}

export interface MissingGvidScan {
	missingFiles: TFile[];
	inspectionFailures: FileIdFailure[];
}

export interface GvidBackfillResult {
	added: number;
	alreadyPresent: number;
	failures: FileIdFailure[];
}

function yieldToUi(): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, 0));
}

function inspectSourceGvid(source: string): { frontmatterExists: boolean; hasGvid: boolean } {
	const info = getFrontMatterInfo(source);
	return {
		frontmatterExists: info.exists,
		hasGvid: info.exists && hasOwnGvid(parseYaml(info.frontmatter)),
	};
}

export class FileIdManager {
	constructor(private app: App) {}

	isTargetFile(file: TFile): boolean {
		return isTargetMarkdownPath(file.path);
	}

	async hasGvid(file: TFile): Promise<boolean> {
		const source = await this.app.vault.read(file);
		return inspectSourceGvid(source).hasGvid;
	}

	async ensureGvid(file: TFile): Promise<'added' | 'existing' | 'skipped'> {
		if (!this.isTargetFile(file)) return 'skipped';

		let added = false;
		await this.app.vault.process(file, (source) => {
			const inspection = inspectSourceGvid(source);
			if (inspection.hasGvid) return source;
			added = true;
			return insertGvidPreservingSource(source, createGvid(), inspection.frontmatterExists);
		});
		return added ? 'added' : 'existing';
	}

	async scanMissingGvid(): Promise<MissingGvidScan> {
		const files = this.app.vault.getMarkdownFiles().filter((file) => this.isTargetFile(file));
		const missingFiles: TFile[] = [];
		const inspectionFailures: FileIdFailure[] = [];

		for (let index = 0; index < files.length; index += 1) {
			const file = files[index]!;
			try {
				if (!(await this.hasGvid(file))) missingFiles.push(file);
			} catch (error) {
				inspectionFailures.push({ file, error });
			}

			if ((index + 1) % SCAN_YIELD_EVERY === 0) await yieldToUi();
		}

		return { missingFiles, inspectionFailures };
	}

	async backfillMissingGvid(files: readonly TFile[]): Promise<GvidBackfillResult> {
		let added = 0;
		let alreadyPresent = 0;
		const failures: FileIdFailure[] = [];

		for (let index = 0; index < files.length; index += 1) {
			const file = files[index]!;
			try {
				const result = await this.ensureGvid(file);
				if (result === 'added') added += 1;
				else if (result === 'existing') alreadyPresent += 1;
			} catch (error) {
				failures.push({ file, error });
			}

			if ((index + 1) % WRITE_YIELD_EVERY === 0) await yieldToUi();
		}

		return { added, alreadyPresent, failures };
	}
}
