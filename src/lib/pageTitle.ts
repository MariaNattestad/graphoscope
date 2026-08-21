import { devBranch } from 'virtual:dev-branch';

/**
 * Tab title for a page. In `vite dev` the current git branch is appended, so
 * several localhost tabs are tellable apart; in any real build the base title
 * is returned unchanged.
 */
export function pageTitle(base: string): string {
	return devBranch ? `${base} — ${devBranch}` : base;
}
