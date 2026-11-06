'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LocalMain = require('@getflywheel/local/main');

const { IPC, PRESSABLE_SSH_HOST, PRESSABLE_SSH_PORT, PRESSABLE_WEBROOT } = require('./constants');
const { PressableApi, API_APPLICATIONS_PAGE } = require('./main/PressableApi');
const { SyncService } = require('./main/SyncService');
const { SshKeyStore } = require('./main/sshKey');
const { Store } = require('./main/store');
const { findBundledBinDir, TransportError } = require('./main/transport');
const { Updater } = require('./main/updater');
const pkg = require('../package.json');

/** A hostname or IPv4 address. It may not start with "-" or ".", so it can never be read as an ssh option. */
const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i;
/** An SSH username (Pressable's are random, like f00dfeed12345678a). Same rule: it may not start with "-". */
const USERNAME_RE = /^[a-z0-9_][a-z0-9._-]*$/i;
/** Read at call time, so tests can simulate Windows. */
const isWindows = () => process.platform === 'win32';

function randomString(length, alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789') {
	const bytes = crypto.randomBytes(length);
	return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

/** "https://example.com/path" or "user@example.com" -> "example.com". */
const cleanHost = (host) => String(host || '').trim().replace(/^[a-z]+:\/\//i, '').replace(/^[^@]*@/, '').split(/[/:]/)[0];

/** A hostname lowercased, or null when it isn't one. */
const cleanDomain = (domain) => {
	const d = String(domain || '').trim().toLowerCase().replace(/\.+$/, '');
	return d && HOSTNAME_RE.test(d) ? d : null;
};

/** The www/non-www twin of a domain: example.com <-> www.example.com. */
const wwwTwin = (domain) => (domain.startsWith('www.') ? domain.slice(4) : `www.${domain}`);

/** Where MyPressable takes SSH keys (they belong to your Pressable user and work on every site you can reach). */
const SSH_KEYS_PAGE = 'MyPressable → your profile → Settings → SSH Keys';
/** Where a site's SSH username and password are shown. */
const SSH_DETAILS_PAGE = 'the site\'s SFTP | SSH Details in MyPressable';

/** An SSH login the server turned down (as opposed to a network error or a missing WordPress). */
const isAuthRefusal = (e) => e instanceof TransportError && (/refused the (SSH key|password)/.test(e.message)
	|| /Permission denied \((publickey|password|keyboard-interactive)|Permission denied, please try again/i.test(e.stderr || ''));

/** Pressable states in which a site can't be reached over SSH yet (or any more). */
const UNLINKABLE_STATES = new Set(['disabled', 'deleted', 'archived', 'suspended', 'creating', 'cloning', 'deploying', 'restoring']);

/**
 * Builds the site picker's choices (IPC.LIST_SITES) from `GET /sites`: one per site, live sites first, then staging
 * sites. Sites that are disabled or still being created are listed but can't be linked.
 */
function toSiteChoices(sites = []) {
	return sites
		.filter((site) => site && site.id !== undefined && site.id !== null)
		.map((site) => {
			const domain = cleanDomain(cleanHost(site.url));
			const state = site.state ? String(site.state).toLowerCase() : null;
			const blocked = state && UNLINKABLE_STATES.has(state);
			return {
				id: String(site.id),
				name: site.name || null,
				displayName: site.displayName || site.name || domain || String(site.id),
				domain,
				url: domain ? `https://${domain}/` : null,
				staging: Boolean(site.staging),
				sandbox: Boolean(site.sandbox),
				state,
				linkable: !blocked && Boolean(domain),
				reason: blocked ? state : domain ? null : 'no domain',
				group: site.staging ? 'Staging sites' : 'Live sites',
			};
		})
		.sort((a, b) => Number(a.staging) - Number(b.staging) || a.displayName.localeCompare(b.displayName));
}

/**
 * The SFTP/SSH user Local logs in as: the one belonging to the API application's owner (matched by email), else the
 * site owner's, else the only one. Null when it can't be told apart from collaborators' users.
 */
function pickSftpUser(users, ownerEmail) {
	const valid = (users || []).filter((u) => u && USERNAME_RE.test(String(u.username || '')));
	const email = String(ownerEmail || '').trim().toLowerCase();
	return (email && valid.find((u) => String(u.email || '').trim().toLowerCase() === email))
		|| valid.find((u) => u.owner === true)
		|| (valid.length === 1 ? valid[0] : null);
}

/** Domains whose URLs a pull rewrites to the Local site: the site's other domains and the www/non-www twin. */
function altDomainsFor(primary, domains) {
	const names = (domains || []).map((d) => cleanDomain(d && d.domainName)).filter(Boolean);
	if (primary) names.push(wwwTwin(primary));
	return [...new Set(names)].filter((d) => d !== primary);
}

module.exports = function PressableConnectMain(context) {
	const { electron } = context;
	const container = LocalMain.getServiceContainer().cradle;
	const logger = container.localLogger.child({ thread: 'main', addon: 'pressable-connect' });
	const { sendIPCEvent } = LocalMain;

	const workDir = path.join(context.environment.userDataPath, 'pressable-connect');
	const store = new Store(workDir, electron.safeStorage);
	const keys = new SshKeyStore(path.join(workDir, 'ssh'));

	let api = null;
	const getApi = () => {
		if (api) return api;
		const account = store.getAccount();
		if (!account) throw new Error('Connect your Pressable account first.');
		api = new PressableApi({ clientId: account.clientId, clientSecret: account.clientSecret, logger });
		return api;
	};

	const syncService = new SyncService({
		store,
		keys,
		workDir,
		getApi: () => (store.getAccount() ? getApi() : null),
		services: {
			siteData: container.siteData,
			siteDatabase: container.siteDatabase,
			siteProcessManager: container.siteProcessManager,
			wpCli: container.wpCli,
		},
		sendIPCEvent,
		logger,
	});

	const updater = new Updater({
		pkg,
		addonDir: path.resolve(__dirname, '..'),
		addonsDir: path.join(context.environment.userDataPath, 'addons'),
		ipcMain: electron.ipcMain,
		app: electron.app,
		logger,
		onChange: () => broadcast(),
	});
	if (electron.app) updater.start();

	const keyComment = () => `local-pressable-connect@${os.hostname()}`.replace(/\s+/g, '-');

	const getState = (siteId) => ({
		account: store.getPublicAccount(),
		link: siteId ? store.getPublicLink(siteId) : null,
		activity: siteId ? syncService.activity(siteId) : null,
		publicKey: keys.getPublicKey(),
		passwordAuthSupported: !isWindows(),
		update: updater.state(),
	});

	const broadcast = (siteId) => sendIPCEvent(IPC.STATE_CHANGED, siteId || null);

	/** Sends step-by-step linking progress to the form that started it (matched by its progressId). */
	const progressReporter = (progressId) => (message) => {
		logger.info(`Linking: ${message}`);
		if (progressId) sendIPCEvent(IPC.LINK_PROGRESS, progressId, message);
	};

	/** Broadcasts once a transfer has registered as active, and again when it settles. */
	const runAndBroadcast = async (siteId, transfer) => {
		broadcast(siteId);
		try {
			return await transfer;
		} finally {
			broadcast(siteId);
		}
	};

	/** Discovery hints for a link: where WordPress should be. */
	const hintsFor = (link) => ({
		remotePath: link.remotePath || null,
		webRoot: link.webRoot || null,
		excludeDirs: link.excludeDirs || [],
	});

	/** Locates WordPress over an SSH login, installing WP-CLI if the server lacks it. */
	const locate = async (login, hints, onProgress) => {
		const transport = syncService.transportFor(login);
		try {
			let remote = await syncService.discoverRemote(transport, hints);
			if (!remote.hasWpCli && remote.hasPhp) {
				onProgress('WP-CLI is missing on the server; installing it in a private folder…');
				remote = await syncService.ensureWpCli(transport, remote);
			}
			return remote;
		} finally {
			await transport.close();
		}
	};

	const remoteFields = (remote) => ({
		remotePath: remote.remotePath,
		privateDir: remote.privateDir,
		nested: remote.nested,
		...(remote.managed ? { managed: remote.managed } : {}),
	});

	/**
	 * Logs in with Local's SSH key and finds WordPress. When the server refuses the key and the user typed the SSH
	 * password (shown in the site's SFTP | SSH Details), logs in with that instead and keeps it, encrypted, in the link.
	 * `hints` default to the link's own discovery hints.
	 */
	const connectWithKeyOrPassword = async (link, password, onProgress, hints = hintsFor(link)) => {
		keys.ensure(keyComment());
		onProgress('Connecting with Local\'s SSH key…');
		try {
			return { ...link, authType: 'key', password: null, ...remoteFields(await locate(link, hints, onProgress)) };
		} catch (e) {
			if (!isAuthRefusal(e)) throw e;
			logger.info(`Pressable refused Local's SSH key for ${link.username}@${link.host}.`);
		}
		// On a site created minutes ago (a new staging copy, say), Pressable refuses even an added key for a minute or so.
		const addKeyHint = `Add Local's public key (shown on this page) in ${SSH_KEYS_PAGE}, then link again. `
			+ 'A site created or a key added in the last few minutes can take a minute or two before Pressable accepts the key.';
		// Windows has no password field (password logins aren't supported there), so it is checked first.
		if (isWindows()) {
			throw new Error(`Pressable refused Local's SSH key, and password authentication is not supported on Windows yet. ${addKeyHint}`);
		}
		if (!password) {
			throw new Error(`Pressable refused Local's SSH key for ${link.username}. ${addKeyHint} Or type the site's SSH password `
				+ `(from ${SSH_DETAILS_PAGE}) and link again.`);
		}
		onProgress('Pressable refused Local\'s SSH key; connecting with the SSH password instead…');
		const withPassword = { ...link, authType: 'password', password };
		try {
			return { ...withPassword, ...remoteFields(await locate(withPassword, hints, onProgress)) };
		} catch (e) {
			if (!isAuthRefusal(e)) throw e;
			throw new Error(`Pressable refused both Local's SSH key and the SSH password for ${link.username}. Check the password in `
				+ `${SSH_DETAILS_PAGE} (Reset shows a new one, which also changes the SFTP password). ${addKeyHint}`);
		}
	};

	/**
	 * Links a site chosen from the account's list. The site is read again by id from the API, never taken from the
	 * renderer, and so are its SSH username and domains. Returns the link to store; nothing is saved yet.
	 */
	const prepareAccountLink = async ({ id, password }, onProgress = () => {}) => {
		const pressable = getApi();
		if (!id || !/^\d+$/.test(String(id))) throw new Error('Choose a Pressable site from the list.');
		onProgress('Reading the site from Pressable…');
		const site = await pressable.getSite(String(id));
		const [choice] = toSiteChoices(site ? [site] : []);
		if (!choice) throw new Error('That Pressable site could not be found. Refresh the list and try again.');
		if (!choice.linkable) throw new Error(`${choice.displayName} can't be linked (${choice.reason}).`);

		onProgress('Reading the site\'s SSH user and domains…');
		const [users, domains] = await Promise.all([pressable.listSftpUsers(choice.id), pressable.listDomains(choice.id)]);
		const user = pickSftpUser(users, pressable.owner && pressable.owner.email);
		if (!user) {
			throw new Error(`Pressable lists no SSH user of yours for ${choice.displayName}. Check the site's Collaborators page in `
				+ 'MyPressable, or link with SFTP/SSH details instead.');
		}
		const primary = (domains.find((d) => d && d.primary) || {}).domainName;
		const domain = cleanDomain(primary) || choice.domain;
		const link = {
			mode: 'account',
			platform: 'pressable',
			host: PRESSABLE_SSH_HOST,
			port: PRESSABLE_SSH_PORT,
			username: String(user.username),
			pressableSiteId: choice.id,
			siteName: choice.name,
			staging: choice.staging,
			domain,
			directory: '',
			webRoot: PRESSABLE_WEBROOT,
			siteTitle: choice.displayName,
			label: choice.displayName,
			altDomains: altDomainsFor(domain, [...domains, { domainName: choice.domain }]),
			excludeDirs: [],
		};
		return connectWithKeyOrPassword(link, password ? String(password) : null, onProgress, { ...hintsFor(link), remotePath: PRESSABLE_WEBROOT });
	};

	/** Builds and verifies a link from a site's SFTP | SSH details. Nothing is saved yet. */
	const prepareManualLink = async ({ host, port, username, authType, password, remotePath, domain }, onProgress = () => {}) => {
		if (authType === 'password' && isWindows()) {
			throw new Error('Password authentication is not supported on Windows yet. Use the SSH key option instead.');
		}
		if (authType !== 'password') keys.ensure(keyComment());
		const link = {
			mode: 'manual',
			platform: null,
			authType: authType === 'password' ? 'password' : 'key',
			host: cleanHost(host) || PRESSABLE_SSH_HOST,
			port: Number(port) || PRESSABLE_SSH_PORT,
			username: String(username || '').trim(),
			password: authType === 'password' ? password : null,
			domain: cleanDomain(cleanHost(domain)),
			altDomains: [],
			excludeDirs: [],
		};
		if (!HOSTNAME_RE.test(link.host)) throw new Error(`Enter the SSH host shown in ${SSH_DETAILS_PAGE} (${PRESSABLE_SSH_HOST}).`);
		if (!USERNAME_RE.test(link.username)) throw new Error(`Enter the SSH username shown in ${SSH_DETAILS_PAGE}.`);
		link.label = link.domain || `${link.username}@${link.host}`;
		if (link.domain) link.altDomains = [wwwTwin(link.domain)];
		onProgress('Connecting over SSH…');
		const typedPath = remotePath ? String(remotePath).trim() : null;
		const remote = await locate(link, { ...hintsFor(link), webRoot: PRESSABLE_WEBROOT, remotePath: typedPath }, onProgress);
		return { ...link, ...remoteFields(remote) };
	};

	const prepareLink = (source, onProgress) => (source && source.kind === 'manual'
		? prepareManualLink(source, onProgress)
		: prepareAccountLink(source || {}, onProgress));

	/** Name, domain and folder for a new Local site, following Local's new-site defaults and avoiding clashes. */
	const newSiteLocation = (siteName) => {
		const defaults = {
			sitesPath: '~/Local Sites/',
			tld: '.local',
			environment: 'flywheel',
			adminEmail: 'dev-email@wpengine.local',
			...(LocalMain.UserData ? LocalMain.UserData.get('settings-new-site-defaults', {}) : {}),
		};
		const slug = String(siteName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'pressable-site';
		const sites = Object.values(container.siteData.getSites());
		const tld = `.${String(defaults.tld).replace(/^\.+/, '')}`;
		const expand = (p) => p.replace(/^~(?=$|[\\/])/, os.homedir());
		for (let i = 1; i < 1000; i += 1) {
			const candidate = i === 1 ? slug : `${slug}-${i}`;
			const domain = `${candidate}${tld}`;
			const sitePath = path.join(defaults.sitesPath, candidate);
			const taken = sites.some((s) => s.domain === domain || path.resolve(expand(s.path)) === path.resolve(expand(sitePath)));
			if (!taken && !fs.existsSync(expand(sitePath))) {
				return { siteName: String(siteName).trim(), domain, sitePath, defaults };
			}
		}
		throw new Error('Could not find a free folder for the new site.');
	};

	const handlers = {
		[IPC.GET_STATE]: (siteId) => getState(siteId),

		[IPC.LINKED_SITES]: () => store.linkedSites(),

		[IPC.GET_PUBLIC_KEY]: () => keys.ensure(keyComment()),

		[IPC.CHECK_UPDATE]: () => updater.check({ manual: true }),

		[IPC.INSTALL_UPDATE]: () => updater.install(),

		[IPC.RESTART_LOCAL]: () => updater.restart(),

		[IPC.CONNECT_ACCOUNT]: async ({ clientId, clientSecret }) => {
			// Credentials contain no whitespace; copy-paste can bring along spaces, line breaks or zero-width characters.
			const clean = (v) => String(v || '').replace(/[\s\u200b-\u200d\u2060\ufeff]/g, '');
			const id = clean(clientId);
			const secret = clean(clientSecret);
			if (!id || !secret) throw new Error(`Paste the Client ID and Client Secret from ${API_APPLICATIONS_PAGE}.`);
			const candidate = new PressableApi({ clientId: id, clientSecret: secret, logger });
			const { sites, name, email } = await candidate.validate();
			store.setAccount({ clientId: id, clientSecret: secret, connectedAt: new Date().toISOString(), sites, name, email });
			api = candidate;
			broadcast();
			return getState();
		},

		[IPC.DISCONNECT_ACCOUNT]: () => {
			store.clearAccount();
			api = null;
			broadcast();
			return getState();
		},

		[IPC.LIST_SITES]: async () => toSiteChoices(await getApi().listSites()),

		[IPC.LINK_ACCOUNT_SITE]: async ({ siteId, progressId, id, password }) => {
			store.setLink(siteId, await prepareAccountLink({ id, password }, progressReporter(progressId)));
			broadcast(siteId);
			return getState(siteId);
		},

		[IPC.LINK_MANUAL]: async ({ siteId, progressId, ...credentials }) => {
			store.setLink(siteId, await prepareManualLink(credentials, progressReporter(progressId)));
			broadcast(siteId);
			return getState(siteId);
		},

		[IPC.COMPARE]: ({ siteId, checksum }) => runAndBroadcast(siteId, syncService.compare(siteId, { checksum })),

		[IPC.NEW_SITE_LOCATION]: (siteName) => {
			const { domain, sitePath } = newSiteLocation(siteName);
			return { domain, sitePath };
		},

		/**
		 * "Pull to a new site": verifies the SSH connection to Pressable first (so a bad login never leaves an empty site
		 * behind), then creates a regular Local site with Local's own add-site service, links it and pulls.
		 * Resolves once the connection is verified; creation and the pull report progress in Local's site overlay.
		 */
		[IPC.PULL_NEW_SITE]: async ({ siteName, source }) => {
			if (!siteName || !String(siteName).trim()) throw new Error('Enter a name for the new site.');
			const link = await prepareLink(source, progressReporter(source && source.progressId));
			const location = newSiteLocation(siteName);

			(async () => {
				let site;
				try {
					site = await container.addSite.addSite({
						newSiteInfo: {
							siteName: location.siteName,
							siteDomain: location.domain,
							sitePath: location.sitePath,
							environment: location.defaults.environment,
							multiSite: '',
						},
						wpCredentials: {
							adminUsername: 'admin',
							adminPassword: randomString(20),
							adminEmail: location.defaults.adminEmail,
						},
						goToSite: true,
						installWP: true,
					});
				} catch (e) {
					// Local shows its own error dialog for failed site creation.
					logger.error(`Could not create the Local site for a Pressable pull: ${e.message}`);
					return;
				}
				store.setLink(site.id, link);
				broadcast(site.id);
				try {
					await runAndBroadcast(site.id, syncService.pull(site.id, { deleteLocal: true, backupLocal: false }));
				} catch (e) {
					// Reported through the site banner.
				}
			})();

			return { domain: location.domain, sitePath: location.sitePath };
		},

		[IPC.UNLINK_SITE]: ({ siteId }) => {
			store.removeLink(siteId);
			broadcast(siteId);
			return getState(siteId);
		},

		[IPC.TEST_CONNECTION]: async (siteId) => {
			const link = store.getLink(siteId);
			if (!link) throw new Error('This site is not linked to Pressable yet.');
			const transport = syncService.transportFor(link);
			try {
				const remote = await syncService.discoverRemote(transport, hintsFor(link));
				store.updateLink(siteId, remoteFields(remote));
				broadcast(siteId);
				return remote;
			} finally {
				await transport.close();
			}
		},

		// Outcomes are reported through site banners like Local Connect; the IPC reply only signals completion.
		[IPC.PUSH]: ({ siteId, options }) => runAndBroadcast(siteId, syncService.push(siteId, options)),

		[IPC.PULL]: ({ siteId, options }) => runAndBroadcast(siteId, syncService.pull(siteId, options)),
	};

	Object.entries(handlers).forEach(([channel, handler]) => LocalMain.addIpcAsyncListener(channel, handler));

	logger.info(`ConnectLocal for Pressable loaded (rsync/ssh from ${findBundledBinDir() || 'system PATH'})`);
};

module.exports.toSiteChoices = toSiteChoices;
module.exports.pickSftpUser = pickSftpUser;
module.exports.altDomainsFor = altDomainsFor;
