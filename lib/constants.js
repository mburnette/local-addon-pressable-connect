'use strict';

/** IPC channels shared by the main and renderer halves of the add-on. */
const IPC = {
	GET_STATE: 'pressableConnect:getState',
	/** siteId -> remote domain for every linked site, for the sites-list marks. */
	LINKED_SITES: 'pressableConnect:linkedSites',
	CONNECT_ACCOUNT: 'pressableConnect:connectAccount',
	DISCONNECT_ACCOUNT: 'pressableConnect:disconnectAccount',
	LIST_SITES: 'pressableConnect:listSites',
	LINK_ACCOUNT_SITE: 'pressableConnect:linkAccountSite',
	LINK_MANUAL: 'pressableConnect:linkManual',
	UNLINK_SITE: 'pressableConnect:unlinkSite',
	TEST_CONNECTION: 'pressableConnect:testConnection',
	PUSH: 'pressableConnect:push',
	PULL: 'pressableConnect:pull',
	COMPARE: 'pressableConnect:compare',
	NEW_SITE_LOCATION: 'pressableConnect:newSiteLocation',
	PULL_NEW_SITE: 'pressableConnect:pullNewSite',
	/** main -> renderer: (progressId, message) while linking. */
	LINK_PROGRESS: 'pressableConnect:linkProgress',
	GET_PUBLIC_KEY: 'pressableConnect:getPublicKey',
	CHECK_UPDATE: 'pressableConnect:checkUpdate',
	INSTALL_UPDATE: 'pressableConnect:installUpdate',
	RESTART_LOCAL: 'pressableConnect:restartLocal',
	/** main -> renderer broadcast whenever stored state changes. */
	STATE_CHANGED: 'pressableConnect:stateChanged',
};

/** Pressable's control panel: the API lives under /v1 and access tokens come from /auth/token. */
const PRESSABLE_API_BASE = 'https://my.pressable.com';

/** Every Pressable site is reached through the same SSH gateway, with a per-site username. */
const PRESSABLE_SSH_HOST = 'ssh.pressable.com';
const PRESSABLE_SSH_PORT = 22;

/** Pressable's webroot. `~/htdocs` in the SSH user's home is a link to it. */
const PRESSABLE_WEBROOT = '/srv/htdocs';

/** Where the official WP-CLI build is downloaded from when a server has no `wp` command. */
const WP_CLI_PHAR_URL = 'https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar';

/**
 * Paths never synced in either direction. rsync --exclude also protects them from --delete, so each side keeps
 * its own server files: Pressable keeps wp-config.php (its database settings come from the platform) and its
 * caching drop-ins, and Local never receives them, since they would break the local site.
 */
const SYNC_EXCLUDES = [
	// Server-specific config
	'/wp-config.php',
	'/.htaccess',
	'/.user.ini',
	'/php.ini',
	'/wp-cli.yml',
	// Server-specific state: Jetpack's firewall rules hold absolute server paths; upgrade/ is WordPress scratch space
	'wp-content/jetpack-waf/',
	'wp-content/upgrade/',
	'wp-content/upgrade-temp-backup/',
	// Pressable's caching drop-ins (links into the platform's own folder) and cache output
	'wp-content/object-cache.php',
	'wp-content/advanced-cache.php',
	'wp-content/cache/',
	// Site backups made by migration plugins: often gigabytes, and never wanted on the other side
	'wp-content/ai1wm-backups/',
	'wp-content/updraft/',
	// VCS and tooling
	'.git/',
	'.svn/',
	'node_modules/.bin/',
	'vendor/bin/',
	'.DS_Store',
	// Stray dumps and Local helpers
	'wp-content/mysql.sql',
	'local-phpinfo.php',
	'local-xdebuginfo.php',
	'wp-content/mu-plugins/local-by-flywheel-demo-urls.php',
	'wp-content/mu-plugins/local-by-flywheel-live-link-helper.php',
	// Ignore files for other hosts and for this add-on
	'.wpe-push-ignore',
	'.wpe-pull-ignore',
	'.cloudways-push-ignore',
	'.cloudways-pull-ignore',
	'.bluehost-push-ignore',
	'.bluehost-pull-ignore',
	'.kinsta-push-ignore',
	'.kinsta-pull-ignore',
	'.hostinger-push-ignore',
	'.hostinger-pull-ignore',
	'.pressable-push-ignore',
	'.pressable-pull-ignore',
];

/**
 * rsync filter rules added after the excludes. Must-use plugins that exist only on the receiving side are never
 * deleted: hosts install their own there, and a push from a Local site without them must not remove them.
 */
const SYNC_PROTECT = [
	'--filter=P wp-content/mu-plugins/*',
];

/**
 * The last filter rules of every transfer: only wp-content moves. Pressable manages WordPress core itself (the
 * webroot holds wp-config.php, wp-content and links into the platform's core folder), so core files are never pushed,
 * and a pull never replaces or deletes Local's own core. Excluded paths are also safe from --delete on both sides.
 */
const SYNC_SCOPE = [
	'--filter=+ /wp-content/',
	'--filter=- /*',
];

/** Optional per-site ignore files in the site's webroot, same idea as .wpe-push-ignore / .wpe-pull-ignore. */
const IGNORE_FILES = {
	push: '.pressable-push-ignore',
	pull: '.pressable-pull-ignore',
};

module.exports = {
	IPC,
	PRESSABLE_API_BASE,
	PRESSABLE_SSH_HOST,
	PRESSABLE_SSH_PORT,
	PRESSABLE_WEBROOT,
	WP_CLI_PHAR_URL,
	SYNC_EXCLUDES,
	SYNC_PROTECT,
	SYNC_SCOPE,
	IGNORE_FILES,
};
