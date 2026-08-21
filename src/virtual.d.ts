// Virtual modules supplied by vite plugins (see vite.config.ts).
declare module 'virtual:dev-branch' {
	/** Current git branch while `vite dev` runs; '' in a real build. */
	export const devBranch: string;
}
