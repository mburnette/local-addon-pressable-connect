'use strict';

const { ipcRenderer, shell } = require('electron');
const { ipcAsync, confirm } = require('@getflywheel/local/renderer');
const {
	Button,
	Checkbox,
	BasicInput,
	FlyModal,
	PrimaryButton,
	Spinner,
	TextButton,
	Title,
} = require('@getflywheel/local-components');

const { IPC } = require('../constants');

/** Pressable's guides: the API, connecting over SSH, and where SSH keys go. */
const API_HELP_URL = 'https://my.pressable.com/documentation/api/v1';
const SSH_HELP_URL = 'https://pressable.com/knowledgebase/connect-to-ssh-on-pressable/';

/** Where MyPressable takes SSH keys, and where it shows a site's SSH username and password. */
const SSH_KEYS_PATH = 'your profile → Settings → SSH Keys';
const SSH_DETAILS_PATH = 'Sites → your site → SFTP | SSH Details';

/** Pressable's SSH gateway. */
const DEFAULT_SSH_HOST = 'ssh.pressable.com';
const DEFAULT_SSH_PORT = '22';

const errorText = (e) => (e && (e.messageMain || e.message)) || String(e);

module.exports = function createComponents({ React }) {
	const h = React.createElement;
	const { useCallback, useEffect, useState } = React;

	/** Loads add-on state for a site and keeps it fresh when the main process reports changes. */
	function usePressableState(siteId) {
		const [state, setState] = useState(null);
		const refresh = useCallback(() => ipcAsync(IPC.GET_STATE, siteId).then(setState).catch(() => {}), [siteId]);
		useEffect(() => {
			refresh();
			const onChange = (_event, changedSiteId) => {
				if (!changedSiteId || changedSiteId === siteId) refresh();
			};
			ipcRenderer.on(IPC.STATE_CHANGED, onChange);
			return () => ipcRenderer.removeListener(IPC.STATE_CHANGED, onChange);
		}, [siteId, refresh]);
		return [state, refresh];
	}

	/** Wraps an async action with busy + error state. */
	function useAction() {
		const [busy, setBusy] = useState(false);
		const [error, setError] = useState(null);
		const run = useCallback(async (fn) => {
			setBusy(true);
			setError(null);
			try {
				return await fn();
			} catch (e) {
				setError(errorText(e));
				return undefined;
			} finally {
				setBusy(false);
			}
		}, []);
		return { busy, error, setError, run };
	}

	/** Step-by-step progress the main process reports while connecting or linking. `start()` returns a progressId. */
	function useLinkProgress() {
		const [progress, setProgress] = useState(null);
		const idRef = React.useRef(null);
		useEffect(() => {
			const onProgress = (_event, id, message) => {
				if (id && id === idRef.current) setProgress(message);
			};
			ipcRenderer.on(IPC.LINK_PROGRESS, onProgress);
			return () => ipcRenderer.removeListener(IPC.LINK_PROGRESS, onProgress);
		}, []);
		const start = () => {
			idRef.current = `link-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			setProgress(null);
			return idRef.current;
		};
		return { progress, start };
	}

	const isChecked = (value, previous) => (typeof value === 'boolean' ? value : !previous);

	const openLink = (url) => (e) => {
		e.preventDefault();
		shell.openExternal(url);
	};

	function Field({ label, help, children }) {
		return h('label', { className: 'PRConnect_Field' },
			h('span', { className: 'PRConnect_FieldLabel' }, label),
			children,
			help ? h('span', { className: 'PRConnect_Help' }, help) : null);
	}

	function TextInput({ value, onChange, type = 'text', placeholder, disabled }) {
		return h(BasicInput, {
			type,
			value: value || '',
			placeholder,
			disabled,
			onChange: (e) => onChange(e.target.value),
		});
	}

	function ErrorNote({ error }) {
		return error ? h('div', { className: 'PRConnect_Error', role: 'alert' }, error) : null;
	}

	function BusyNote({ busy, children }) {
		return busy ? h('div', { className: 'PRConnect_Busy' }, h(Spinner, null), h('span', null, children)) : null;
	}

	function Tabs({ value, onChange, tabs, className = 'PRConnect_Tabs' }) {
		return h('div', { className, role: 'tablist' },
			tabs.map(([key, label]) => h('button', {
				key,
				type: 'button',
				role: 'tab',
				'aria-selected': value === key,
				className: `PRConnect_Tab${value === key ? ' is-active' : ''}`,
				onClick: () => onChange(key),
			}, label)));
	}

	function PublicKeyBox() {
		const [publicKey, setPublicKey] = useState('');
		const [copied, setCopied] = useState(false);
		useEffect(() => {
			ipcAsync(IPC.GET_PUBLIC_KEY).then(setPublicKey).catch(() => {});
		}, []);
		const copy = () => {
			navigator.clipboard.writeText(publicKey).then(() => {
				setCopied(true);
				setTimeout(() => setCopied(false), 1500);
			});
		};
		return h('div', { className: 'PRConnect_KeyBox' },
			h('textarea', { readOnly: true, value: publicKey, rows: 4, className: 'PRConnect_KeyText' }),
			h(TextButton, { onClick: copy, disabled: !publicKey }, copied ? 'Copied' : 'Copy public key'));
	}

	/** Password or SSH key, as radio buttons. Password is offered only where the platform supports it. */
	function AuthChoice({ state, value, onChange }) {
		return h('div', { className: 'PRConnect_AuthChoice' },
			state.passwordAuthSupported
				? h('label', null, h('input', { type: 'radio', checked: value === 'password', onChange: () => onChange('password') }), ' Password')
				: null,
			h('label', null, h('input', { type: 'radio', checked: value === 'key', onChange: () => onChange('key') }), ' SSH key'));
	}

	/** Options, wording and channel for each direction. */
	const DIRECTIONS = {
		push: {
			channel: IPC.PUSH,
			verb: 'Push',
			gerund: 'Pushing',
			button: 'Push to Pressable',
			defaults: () => ({ files: true, database: true, deleteRemote: true, purgeCache: true }),
			checkboxes: (link, options) => [
				['files', 'Files (wp-content: plugins, themes and uploads)'],
				['database', 'Database (with URL search & replace)'],
				options.files && ['deleteRemote', 'Delete files in wp-content on Pressable that are not in Local'],
				['purgeCache', 'Clear Pressable caches afterwards (object cache and Edge Cache)'],
			],
			consequences: ({ what, where, site, options }) => [
				`This overwrites the ${what} on ${where} with ${site.name} from Local. Visitors see the change right away.`,
				options.database && 'The Pressable database is replaced; the previous one is saved as local-backup-before-push.sql in a private .pressable-connect folder in the site\'s SSH home folder, outside the website.',
				options.files && options.deleteRemote && 'Files in wp-content on Pressable that do not exist locally will be deleted. WordPress core, wp-config.php and the plugins and drop-ins Pressable manages (Jetpack, Akismet, the caching drop-ins) are never touched.',
				'This push does not make a Pressable backup. To roll back, restore one of Pressable\'s daily backups in MyPressable (the site\'s Backups tab).',
			],
		},
		pull: {
			channel: IPC.PULL,
			verb: 'Pull',
			gerund: 'Pulling',
			button: 'Pull from Pressable',
			defaults: () => ({ files: true, database: true, backupLocal: true, deleteLocal: true }),
			checkboxes: (link, options) => [
				['files', 'Files (wp-content, without Pressable\'s caching drop-ins; Local keeps its own WordPress core)'],
				['database', 'Database (with URL search & replace)'],
				options.database && ['backupLocal', 'Back up the Local database first'],
				options.files && ['deleteLocal', 'Delete Local files that are not on Pressable'],
			],
			consequences: ({ what, where, site, options }) => [
				`This overwrites the ${what} of ${site.name} in Local with ${where}.`,
				options.database && (options.backupLocal
					? 'The Local database is replaced; the previous one is saved in app/sql/local-backup-before-pull.sql.'
					: 'The Local database is replaced without a backup.'),
				options.files && options.deleteLocal && 'Files in wp-content in Local that do not exist on Pressable will be deleted.',
				options.files && 'Local files the pull replaces or deletes are moved to app/pressable-backups (the last 3 pulls are kept).',
			],
		},
	};

	const linkTarget = (link) => link.label || link.domain || link.host;

	/**
	 * Push or pull options, shared by the Tools panel and the header modal. Inside the modal the modal itself is the
	 * confirmation and it closes as soon as the transfer starts (progress shows in the site overlay, like Local Connect).
	 */
	function TransferForm({ direction, site, link, activity, inModal = false, onStarted }) {
		const config = DIRECTIONS[direction];
		const [options, setOptions] = useState(() => config.defaults(link));
		const { busy, error, run } = useAction();
		const toggle = (key) => (value) => setOptions((o) => ({ ...o, [key]: isChecked(value, o[key]) }));
		const nothingSelected = !options.files && !options.database;
		const where = linkTarget(link);
		const what = options.files && options.database ? 'files and database' : options.files ? 'files' : 'database';
		const consequences = config.consequences({ what, where, site, link, options }).filter(Boolean);
		const running = busy || activity === direction;

		const start = async () => {
			if (!inModal) {
				await confirm({
					title: `${config.verb} ${what} ${direction === 'push' ? 'to' : 'from'} Pressable?`,
					message: h('div', null, consequences.map((text) => h('p', { key: text }, text))),
					buttonText: config.verb,
				});
			}
			const request = ipcAsync(config.channel, { siteId: site.id, options });
			if (onStarted) {
				onStarted();
				// Failures surface as a site banner, as with Local Connect.
				request.catch(() => {});
				return;
			}
			await run(() => request);
		};

		return h('div', { className: 'PRConnect_TransferForm' },
			h('div', { className: 'PRConnect_Options' },
				config.checkboxes(link, options).filter(Boolean).map(([key, label]) => h(Checkbox, {
					key,
					label,
					checked: options[key],
					onChange: toggle(key),
				}))),
			inModal ? h('ul', { className: 'PRConnect_Consequences' }, consequences.map((text) => h('li', { key: text }, text))) : null,
			h(ErrorNote, { error }),
			h('div', { className: 'PRConnect_Actions' },
				h(PrimaryButton, { onClick: start, disabled: running || Boolean(activity) || nothingSelected }, running ? `${config.gerund}…` : config.button)));
	}

	const describeAuth = (link) => (link.authType === 'password'
		? `SSH password (stored encrypted). Add Local's SSH key in MyPressable → ${SSH_KEYS_PATH} and link again to use the key instead.`
		: 'Local\'s SSH key');

	/** The Pressable site a link belongs to, and whether it is a staging site. */
	const describeSite = (link) => (link.pressableSiteId
		? `${link.siteName || link.pressableSiteId}${link.staging ? ' (staging)' : ''}`
		: null);

	/** Folders inside the webroot that are never transferred: other WordPress installs and other websites. */
	const neverSynced = (link) => [...new Set([...(link.nested || []), ...(link.excludeDirs || [])])];

	const describeLast = (last) => `${new Date(last.at).toLocaleString()} (${[last.files && 'files', last.database && 'database'].filter(Boolean).join(' + ')}, ${last.seconds}s)`;

	function LinkedView({ site, state }) {
		const { link } = state;
		const test = useAction();
		const unlink = useAction();
		const [testResult, setTestResult] = useState(null);
		const [direction, setDirection] = useState('push');

		const skipped = neverSynced(link);
		const rows = [
			link.label && ['Site', link.label],
			link.domain && !String(link.label || '').includes(link.domain) && ['Domain', link.domain],
			describeSite(link) && ['Pressable site', describeSite(link)],
			['SSH login', `${link.username}@${link.host}${Number(link.port) !== 22 ? `:${link.port}` : ''}`],
			link.remotePath && ['Remote path', link.remotePath],
			skipped.length ? ['Never synced', `Other sites in subfolders: ${skipped.join(', ')}`] : null,
			['Authentication', describeAuth(link)],
			link.lastPush && ['Last push', describeLast(link.lastPush)],
			link.lastPull && ['Last pull', describeLast(link.lastPull)],
		].filter(Boolean);

		return h('div', null,
			h('table', { className: 'PRConnect_Table' },
				h('tbody', null, rows.map(([k, v]) => h('tr', { key: k }, h('th', null, k), h('td', null, v))))),
			h(Tabs, {
				value: direction,
				onChange: setDirection,
				tabs: [['push', 'Push to Pressable'], ['pull', 'Pull from Pressable'], ['compare', 'Compare & sync files']],
				className: 'PRConnect_Tabs PRConnect_Tabs--Transfer',
			}),
			direction === 'compare'
				? h(CompareView, { site, activity: state.activity })
				: h(TransferForm, { key: direction, direction, site, link, activity: state.activity }),
			h('div', { className: 'PRConnect_Secondary' },
				h(TextButton, {
					disabled: test.busy,
					onClick: () => test.run(async () => {
						setTestResult(null);
						const remote = await ipcAsync(IPC.TEST_CONNECTION, site.id);
						// A push or pull installs WP-CLI in a private folder when the server has PHP but no `wp`.
						const wpCli = remote.hasWpCli ? '' : remote.hasPhp
							? ' (WP-CLI missing: the first database push or pull installs it in a private folder)'
							: ' (WP-CLI and PHP missing: database transfers will fail)';
						setTestResult(`Connected. WordPress found at ${remote.remotePath}${wpCli}.`);
					}),
				}, test.busy ? 'Testing…' : 'Test connection'),
				h(TextButton, {
					intent: 'destructive',
					disabled: unlink.busy || Boolean(state.activity),
					onClick: () => unlink.run(() => ipcAsync(IPC.UNLINK_SITE, { siteId: site.id })),
				}, 'Unlink from Pressable')),
			testResult ? h('div', { className: 'PRConnect_Success' }, testResult) : null,
			h(ErrorNote, { error: test.error || unlink.error }));
	}

	/** Connects a Pressable API application, which lists the account's sites and each site's SSH user. */
	function AccountConnectForm() {
		const [clientId, setClientId] = useState('');
		const [clientSecret, setClientSecret] = useState('');
		const action = useAction();

		return h('div', { className: 'PRConnect_Form' },
			h('p', { className: 'PRConnect_Intro' },
				'Connect with a Pressable API application. Local then lists your sites, finds each one\'s SSH login for you, and can purge the Edge Cache after a push. In MyPressable, open ',
				h('strong', null, 'API Applications'),
				' in the sidebar (under Account), create an application, and copy its Client ID and Client Secret. Give it read access to Sites, FTP and Domains, and edit access to Sites. ',
				h('a', { href: '#', onClick: openLink(API_HELP_URL) }, 'Pressable\'s API docs')),
			h(Field, { label: 'Client ID' },
				h(TextInput, { value: clientId, onChange: setClientId })),
			h(Field, { label: 'Client Secret', help: 'Stored encrypted with your system keychain.' },
				h(TextInput, { value: clientSecret, onChange: setClientSecret, type: 'password' })),
			h(BusyNote, { busy: action.busy }, 'Checking the application…'),
			h(ErrorNote, { error: action.error }),
			h('div', { className: 'PRConnect_Actions' },
				h(PrimaryButton, {
					disabled: action.busy || !clientId.trim() || !clientSecret.trim(),
					onClick: () => action.run(() => ipcAsync(IPC.CONNECT_ACCOUNT, { clientId, clientSecret })),
				}, action.busy ? 'Connecting…' : 'Connect account')));
	}

	/** "Shop — shop.example.com (disabled)": the display name when it says more than the domain. */
	const choiceLabel = (choice) => {
		const address = choice.domain || choice.id;
		const title = choice.displayName && choice.displayName !== choice.domain ? `${choice.displayName} — ` : '';
		return `${title}${address}${choice.linkable === false ? ` (${choice.reason || 'unavailable'})` : ''}`;
	};
	const choiceName = (choice) => choice.displayName || choice.domain || '';
	const countSites = (n) => (typeof n === 'number' ? ` · ${n} site${n === 1 ? '' : 's'}` : '');

	/** Groups site choices under their `group` label (live or staging), keeping the main process's order. */
	const groupChoices = (choices) => {
		const groups = new Map();
		choices.forEach((choice) => {
			const label = choice.group || 'Sites';
			if (!groups.has(label)) groups.set(label, []);
			groups.get(label).push(choice);
		});
		return [...groups.entries()];
	};

	/**
	 * Picks a site from the connected Pressable account. `onSubmit({ kind: 'account', id, password? , … })` links it
	 * (or, on the new-site page, creates a site and pulls it). The main process reads the site again by `id`; the SSH
	 * password is only sent when the user typed one.
	 */
	function AccountSetup({ state, submitLabel, canSubmit = true, onSubmit, onSiteSelected }) {
		const [choices, setChoices] = useState(null);
		const [selected, setSelected] = useState('');
		const [password, setPassword] = useState('');
		const action = useAction();
		const { progress, start } = useLinkProgress();

		const loadSites = useCallback(() => action.run(async () => {
			const list = await ipcAsync(IPC.LIST_SITES);
			setChoices(list);
			const first = list.find((c) => c.linkable !== false) || list[0];
			if (first) setSelected(first.id);
		}), [action.run]);

		useEffect(() => {
			if (state.account && choices === null) loadSites();
		}, [state.account]);

		const choice = choices && choices.find((c) => c.id === selected);
		const usable = Boolean(choice) && choice.linkable !== false;

		useEffect(() => {
			if (choice && onSiteSelected) onSiteSelected(choice);
		}, [choice && choice.id]);

		if (!state.account) return h(AccountConnectForm);

		const { account } = state;
		return h('div', { className: 'PRConnect_Form' },
			h('div', { className: 'PRConnect_Account' },
				h('span', null, 'Connected to ', h('strong', null, account.email || account.name || 'Pressable'), countSites(account.sites)),
				h(TextButton, {
					onClick: () => action.run(async () => {
						await ipcAsync(IPC.DISCONNECT_ACCOUNT);
						setChoices(null);
					}),
				}, 'Disconnect')),
			choices === null
				// A failed listing shows its error (below) and the Refresh button instead of spinning forever.
				? h(BusyNote, { busy: !action.error }, 'Loading your Pressable sites…')
				: choices.length === 0
					? h('p', null, 'No sites were found for this API application. Sites you collaborate on in another account can be linked with SFTP/SSH details instead.')
					: h(Field, { label: 'Site', help: choice && !usable ? `This site can't be linked: ${choice.reason || 'unavailable'}.` : null },
						h('select', { className: 'PRConnect_Select', value: selected, onChange: (e) => setSelected(e.target.value) },
							groupChoices(choices).map(([label, group]) => h('optgroup', { key: label, label },
								group.map((c) => h('option', { key: c.id, value: c.id, disabled: c.linkable === false }, choiceLabel(c))))))),
			choices && choices.length
				? h(React.Fragment, null,
					h(Field, {
						label: 'Local\'s SSH key',
						help: h(React.Fragment, null,
							`Add this key in MyPressable → ${SSH_KEYS_PATH}. It works on every site you can reach, and Local then logs in with it. `,
							h('a', { href: '#', onClick: openLink(SSH_HELP_URL) }, 'Pressable\'s SSH guide')),
					}, h(PublicKeyBox)),
					state.passwordAuthSupported
						? h(Field, {
							label: 'SSH password (optional)',
							help: `Only needed if you haven't added Local's key: the SSH password shown in ${SSH_DETAILS_PATH}. Stored encrypted with your system keychain.`,
						}, h(TextInput, { value: password, onChange: setPassword, type: 'password' }))
						: null)
				: null,
			h(BusyNote, { busy: action.busy && choices !== null }, progress || 'Linking…'),
			h(ErrorNote, { error: action.error }),
			h('div', { className: 'PRConnect_Actions' },
				h(PrimaryButton, {
					disabled: action.busy || !usable || !canSubmit,
					onClick: () => action.run(() => onSubmit({
						kind: 'account',
						id: choice.id,
						...(password ? { password } : {}),
						progressId: start(),
					})),
				}, submitLabel),
				h(TextButton, { disabled: action.busy, onClick: loadSites }, 'Refresh list')));
	}

	/**
	 * SSH details copied from the site's SFTP | SSH Details in MyPressable, for sites the API application can't see.
	 * `onSubmit({ kind: 'manual', host, port, username, authType, password, remotePath, domain, progressId })`.
	 */
	function ManualSetup({ state, submitLabel, canSubmit = true, onSubmit }) {
		const [form, setForm] = useState({ host: DEFAULT_SSH_HOST, port: DEFAULT_SSH_PORT, username: '', authType: 'key', password: '', remotePath: '', domain: '' });
		const set = (key) => (value) => setForm((f) => ({ ...f, [key]: value }));
		const action = useAction();
		const { progress, start } = useLinkProgress();
		const complete = form.host.trim() && form.port.trim() && form.username.trim() && (form.authType === 'key' || form.password);

		return h('div', { className: 'PRConnect_Form' },
			h('p', { className: 'PRConnect_Intro' },
				'No API application? Copy the login from MyPressable: open ',
				h('strong', null, SSH_DETAILS_PATH),
				'. It lists the SSH username, and Reset shows a new password (which also changes the SFTP password). ',
				h('a', { href: '#', onClick: openLink(SSH_HELP_URL) }, 'Pressable\'s guide')),
			h('div', { className: 'PRConnect_Row' },
				h(Field, { label: 'SSH host' }, h(TextInput, { value: form.host, onChange: set('host'), placeholder: DEFAULT_SSH_HOST })),
				h(Field, { label: 'Port' }, h(TextInput, { value: form.port, onChange: set('port'), placeholder: DEFAULT_SSH_PORT }))),
			h(Field, { label: 'Username', help: 'Each site has its own random SSH username.' }, h(TextInput, { value: form.username, onChange: set('username'), placeholder: 'a1b2c3d4e5f6a7b8c' })),
			h(AuthChoice, { state, value: form.authType, onChange: set('authType') }),
			form.authType === 'password'
				? h(Field, { label: 'Password', help: 'The site\'s SSH password. Stored encrypted with your system keychain.' }, h(TextInput, { value: form.password, onChange: set('password'), type: 'password' }))
				: h(Field, { label: 'Public key', help: `Add it in MyPressable → ${SSH_KEYS_PATH} first.` }, h(PublicKeyBox)),
			h(Field, { label: 'Site domain (optional)', help: 'Used as the site\'s URL if the database has no home URL yet, and to replace the www twin on pull.' },
				h(TextInput, { value: form.domain, onChange: set('domain'), placeholder: 'example.com' })),
			h(Field, { label: 'Remote path (optional)', help: 'The folder that holds wp-config.php. Detected automatically when left empty.' },
				h(TextInput, { value: form.remotePath, onChange: set('remotePath'), placeholder: '/srv/htdocs' })),
			h(BusyNote, { busy: action.busy }, progress || 'Connecting…'),
			h(ErrorNote, { error: action.error }),
			h('div', { className: 'PRConnect_Actions' },
				h(PrimaryButton, {
					disabled: action.busy || !complete || !canSubmit,
					onClick: () => action.run(() => onSubmit({ kind: 'manual', ...form, progressId: start() })),
				}, action.busy ? 'Connecting…' : submitLabel)));
	}

	function SetupView(props) {
		const [mode, setMode] = useState('account');
		return h('div', null,
			h(Tabs, { value: mode, onChange: setMode, tabs: [['account', 'Pressable API'], ['manual', 'SFTP/SSH details']] }),
			mode === 'account' ? h(AccountSetup, props) : h(ManualSetup, props));
	}

	// ---------------------------------------------------------------- updates

	/** Announces a newer release and installs it through Local's add-on installer. */
	function UpdateNotice({ update }) {
		const action = useAction();
		if (!update) return null;
		const error = action.error || update.error;
		if (update.installed) {
			return h('div', { className: 'PRConnect_Update', role: 'status' },
				h('span', null, `${update.name} ${update.latest} is installed. Restart Local to start using it.`),
				h('div', { className: 'PRConnect_UpdateActions' },
					h(PrimaryButton, { onClick: () => action.run(() => ipcAsync(IPC.RESTART_LOCAL)) }, 'Restart Local')));
		}
		if (!update.latest) return error && !update.checking ? h(ErrorNote, { error }) : null;
		const busy = action.busy || update.installing;
		return h('div', { className: 'PRConnect_Update', role: 'status' },
			h('span', null, `${update.name} ${update.latest} is available. You have ${update.current}.`),
			update.devInstall
				? h('span', { className: 'PRConnect_Help' }, 'This copy is linked from a development folder, so update that folder instead.')
				: null,
			h('div', { className: 'PRConnect_UpdateActions' },
				update.devInstall
					? null
					: h(PrimaryButton, { disabled: busy, onClick: () => action.run(() => ipcAsync(IPC.INSTALL_UPDATE)) }, busy ? 'Updating…' : 'Update'),
				update.releaseUrl ? h(TextButton, { onClick: () => shell.openExternal(update.releaseUrl) }, 'What\'s new') : null),
			error ? h(ErrorNote, { error }) : null);
	}

	/** Version line with a manual "Check for updates". */
	function VersionFooter({ update }) {
		const [checked, setChecked] = useState(false);
		if (!update) return null;
		const check = () => ipcAsync(IPC.CHECK_UPDATE).then(() => setChecked(true)).catch(() => {});
		const upToDate = checked && !update.checking && !update.latest && !update.error;
		return h('div', { className: 'PRConnect_Version' },
			h('span', null, `${update.name} ${update.current}`),
			update.checking
				? h('span', null, 'Checking for updates…')
				: upToDate
					? h('span', null, 'You have the latest version.')
					: update.latest ? null : h(TextButton, { onClick: check }, 'Check for updates'));
	}

	const linkSite = (siteId) => ({ kind, ...source }) => (kind === 'account'
		? ipcAsync(IPC.LINK_ACCOUNT_SITE, { siteId, ...source })
		: ipcAsync(IPC.LINK_MANUAL, { siteId, ...source }));

	function PressablePanel({ site }) {
		const [state] = usePressableState(site && site.id);
		if (!site) return null;
		return h('div', { className: 'PRConnect' },
			h(Title, { size: 'm', className: 'PRConnect_Title' }, 'Pressable'),
			state ? h(UpdateNotice, { update: state.update }) : null,
			!state
				? h(BusyNote, { busy: true }, 'Loading…')
				: state.link
					? h(LinkedView, { site, state })
					: h(SetupView, { state, submitLabel: `Link ${site.name}`, onSubmit: linkSite(site.id) }),
			state ? h(VersionFooter, { update: state.update }) : null);
	}

	// ---------------------------------------------------------------- compare & selective sync

	const formatSize = (bytes) => {
		if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '';
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	};
	const formatTime = (sec) => (sec ? new Date(sec * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
	const describeSide = (side) => (side ? [formatSize(side.size), formatTime(side.mtime)].filter(Boolean).join(' · ') : '');

	const GROUPS = [
		['changed', 'Different on each side'],
		['local-only', 'Only in Local'],
		['remote-only', 'Only on Pressable'],
	];
	const NEWER = { local: 'Newer in Local', remote: 'Newer on Pressable', same: 'Same date' };
	const ROW_LIMIT = 200;

	function CompareRow({ entry, checked, onToggle }) {
		return h('label', { className: 'PRConnect_FileRow' },
			h('input', { type: 'checkbox', checked, onChange: onToggle }),
			h('span', { className: 'PRConnect_FilePath', title: entry.path }, entry.path, entry.type === 'symlink' ? ' (link)' : ''),
			entry.status === 'changed'
				? h('span', { className: 'PRConnect_FileMeta' },
					h('span', null, `Local: ${describeSide(entry.local)}`),
					h('span', null, `Pressable: ${describeSide(entry.remote)}`),
					entry.newer ? h('span', { className: `PRConnect_Badge PRConnect_Badge--${entry.newer}` }, NEWER[entry.newer]) : null)
				: h('span', { className: 'PRConnect_FileMeta' }, describeSide(entry.status === 'local-only' ? entry.local : entry.remote)));
	}

	/**
	 * MagicSync-style comparison: lists files that differ between Local and Pressable, lets you tick files, and
	 * pushes or pulls only those. A ticked file missing on the sending side is deleted on the receiving side.
	 */
	function CompareView({ site, activity }) {
		const [result, setResult] = useState(null);
		const [checksum, setChecksum] = useState(false);
		const [filter, setFilter] = useState('');
		const [selected, setSelected] = useState(() => new Set());
		const compareAction = useAction();
		const syncAction = useAction();

		const compare = () => compareAction.run(async () => {
			const res = await ipcAsync(IPC.COMPARE, { siteId: site.id, checksum });
			setResult(res);
			setSelected(new Set());
		});

		const entries = result ? result.entries : [];
		const needle = filter.trim().toLowerCase();
		const visible = needle ? entries.filter((e) => e.path.toLowerCase().includes(needle)) : entries;
		const toggle = (p) => setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(p)) next.delete(p);
			else next.add(p);
			return next;
		});
		const setGroup = (list, on) => setSelected((prev) => {
			const next = new Set(prev);
			list.forEach((e) => (on ? next.add(e.path) : next.delete(e.path)));
			return next;
		});

		const chosen = entries.filter((e) => selected.has(e.path));
		const count = (statuses) => chosen.filter((e) => statuses.includes(e.status)).length;

		const sync = async (direction) => {
			const send = direction === 'push' ? count(['changed', 'local-only']) : count(['changed', 'remote-only']);
			const remove = direction === 'push' ? count(['remote-only']) : count(['local-only']);
			const there = direction === 'push' ? 'on Pressable' : 'in Local';
			await confirm({
				title: `${direction === 'push' ? 'Push' : 'Pull'} ${chosen.length} selected file${chosen.length === 1 ? '' : 's'}?`,
				message: h('div', null,
					send ? h('p', null, `${send} file${send === 1 ? '' : 's'} will be ${direction === 'push' ? 'uploaded to Pressable' : 'downloaded to Local'}, replacing the copy ${there}.`) : null,
					remove ? h('p', null, `${remove} file${remove === 1 ? '' : 's'} that only exist${remove === 1 ? 's' : ''} ${there} will be deleted ${there}.`) : null,
					h('p', null, 'The database is not changed.')),
				buttonText: direction === 'push' ? 'Push' : 'Pull',
			});
			await syncAction.run(async () => {
				const fileList = chosen.map((e) => e.path);
				const options = direction === 'push' ? { fileList, purgeCache: true } : { fileList };
				await ipcAsync(direction === 'push' ? IPC.PUSH : IPC.PULL, { siteId: site.id, options });
				await compare();
			});
		};

		const busy = compareAction.busy || syncAction.busy || Boolean(activity);

		return h('div', { className: 'PRConnect_Compare' },
			h('p', { className: 'PRConnect_Intro' },
				'See which files differ between Local and Pressable, then push or pull only the ones you pick. Nothing changes until you choose.'),
			h('div', { className: 'PRConnect_Actions PRConnect_Actions--Top' },
				h(PrimaryButton, { onClick: compare, disabled: busy }, compareAction.busy || activity === 'compare' ? 'Comparing…' : result ? 'Compare again' : 'Compare with Pressable'),
				h(Checkbox, { label: 'Compare file contents (slower)', checked: checksum, onChange: (v) => setChecksum((p) => isChecked(v, p)) })),
			h(ErrorNote, { error: compareAction.error || syncAction.error }),
			result
				? h('div', null,
					h('p', { className: 'PRConnect_Summary', role: 'status' },
						entries.length === 0
							? 'Local and Pressable have the same files.'
							: GROUPS.map(([key, label]) => `${entries.filter((e) => e.status === key).length} ${label.toLowerCase()}`).join(' · ')),
					entries.length
						? h(React.Fragment, null,
							h('div', { className: 'PRConnect_Filter' },
								h(TextInput, { value: filter, onChange: setFilter, placeholder: 'Filter by path, e.g. wp-content/themes' })),
							GROUPS.map(([key, label]) => {
								const list = visible.filter((e) => e.status === key);
								if (!list.length) return null;
								const allOn = list.every((e) => selected.has(e.path));
								return h('section', { key, className: 'PRConnect_Group' },
									h('label', { className: 'PRConnect_GroupHeader' },
										h('input', { type: 'checkbox', checked: allOn, onChange: () => setGroup(list, !allOn) }),
										h('span', null, `${label} (${list.length})`)),
									list.slice(0, ROW_LIMIT).map((entry) => h(CompareRow, {
										key: entry.path,
										entry,
										checked: selected.has(entry.path),
										onToggle: () => toggle(entry.path),
									})),
									list.length > ROW_LIMIT
										? h('p', { className: 'PRConnect_Help' }, `${list.length - ROW_LIMIT} more not shown. Narrow the list with the filter; the group checkbox still selects all ${list.length}.`)
										: null);
							}),
							h('div', { className: 'PRConnect_Actions PRConnect_SyncBar' },
								h('span', null, `${chosen.length} selected`),
								h(Button, { disabled: busy || !chosen.length, onClick: () => sync('pull') }, syncAction.busy && activity === 'pull' ? 'Pulling…' : 'Pull selected'),
								h(PrimaryButton, { disabled: busy || !chosen.length, onClick: () => sync('push') }, syncAction.busy && activity === 'push' ? 'Pushing…' : 'Push selected')))
						: null)
				: null);
	}

	// ---------------------------------------------------------------- pull to a new site

	/** Page behind Local's "Create a site → Pull from Pressable" option. */
	function NewSitePage({ history }) {
		const [state] = usePressableState(null);
		const [siteName, setSiteName] = useState('');
		const [nameTouched, setNameTouched] = useState(false);
		const [location, setLocation] = useState(null);
		const [started, setStarted] = useState(null);

		useEffect(() => {
			const name = siteName.trim();
			if (!name) {
				setLocation(null);
				return undefined;
			}
			const timer = setTimeout(() => {
				ipcAsync(IPC.NEW_SITE_LOCATION, name).then(setLocation).catch(() => setLocation(null));
			}, 200);
			return () => clearTimeout(timer);
		}, [siteName]);

		const onSiteSelected = (choice) => {
			if (!nameTouched) setSiteName(choiceName(choice));
		};

		const submit = async (source) => {
			const res = await ipcAsync(IPC.PULL_NEW_SITE, { siteName: siteName.trim(), source });
			setStarted(res);
		};

		return h('div', { className: 'PRConnect PRConnect_NewSite' },
			h('div', { className: 'PRConnect_NewSiteHeader' },
				h(TextButton, { onClick: () => history.push('/main/create-site') }, '← Back'),
				h(Title, { size: 'l', className: 'PRConnect_Title' }, 'Pull from Pressable')),
			h('p', { className: 'PRConnect_Intro' },
				'Creates a new Local site, then pulls the wp-content files and database of a Pressable site into it. Your Pressable site is not changed.'),
			state ? h(UpdateNotice, { update: state.update }) : null,
			started
				? h('div', { className: 'PRConnect_Success', role: 'status' },
					`Creating ${siteName.trim()} at ${started.domain}. Progress continues in the site's overlay.`)
				: h(React.Fragment, null,
					h(Field, {
						label: 'Local site name',
						help: location ? `${location.domain} · ${location.sitePath}` : 'Defaults to the Pressable site\'s name.',
					}, h(TextInput, { value: siteName, onChange: (v) => { setNameTouched(true); setSiteName(v); }, placeholder: 'My Pressable site' })),
					!state
						? h(BusyNote, { busy: true }, 'Loading…')
						: h(SetupView, {
							state,
							submitLabel: 'Create site & pull',
							canSubmit: Boolean(siteName.trim()),
							onSubmit: submit,
							onSiteSelected,
						})));
	}

	function HeaderButtons({ site }) {
		const [state] = usePressableState(site && site.id);
		const [open, setOpen] = useState(null);
		if (!site || !state || !state.link) return null;
		const { link, activity } = state;
		const button = (direction) => h(Button, {
			key: direction,
			className: 'PRConnect_HeaderButton',
			disabled: Boolean(activity),
			onClick: () => setOpen(direction),
			title: `${DIRECTIONS[direction].button} (${linkTarget(link)})`,
		}, activity === direction ? `${DIRECTIONS[direction].gerund}…` : DIRECTIONS[direction].verb);

		return h('span', { className: 'PRConnect_HeaderButtons' },
			h('span', { className: 'PRConnect_HeaderLabel' }, 'Pressable'),
			button('pull'),
			button('push'),
			open
				? h(FlyModal, { isOpen: true, contentLabel: DIRECTIONS[open].button, onRequestClose: () => setOpen(null) },
					h('div', { className: 'PRConnect PRConnect_Modal' },
						h(Title, { size: 'l', className: 'PRConnect_Title' }, DIRECTIONS[open].button),
						h('p', { className: 'PRConnect_Intro' }, open === 'push'
							? `${site.name} → ${linkTarget(link)}`
							: `${linkTarget(link)} → ${site.name}`),
						h(TransferForm, { direction: open, site, link, activity, inModal: true, onStarted: () => setOpen(null) })))
				: null);
	}

	return { PressablePanel, HeaderButtons, TransferForm, CompareView, NewSitePage };
};
