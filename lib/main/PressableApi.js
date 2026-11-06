'use strict';

const { PRESSABLE_API_BASE } = require('../constants');

class PressableApiError extends Error {
	constructor(message, status, body) {
		super(message);
		this.name = 'PressableApiError';
		this.status = status;
		this.body = body;
	}
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Largest page `GET /sites` accepts. */
const PER_PAGE = 50;
/** Stops a misbehaving paginated listing from looping forever. */
const MAX_PAGES = 100;
/** A token is renewed this long before Pressable says it expires, so a request never goes out with a stale one. */
const TOKEN_MARGIN_MS = 60 * 1000;

/** Where the API application (Client ID and secret) is created. */
const API_APPLICATIONS_PAGE = 'MyPressable → API Applications';

/**
 * Pulls the most useful human-readable message out of a Pressable error body. Pressable answers
 * `{ message, data, errors: [messages] }`; the token endpoint answers OAuth's `{ error, error_description }`.
 */
function errorMessageFrom(body, status) {
	if (body && typeof body === 'object') {
		if (typeof body.error_description === 'string' && body.error_description) return body.error_description;
		const errors = Array.isArray(body.errors) ? body.errors : body.errors && typeof body.errors === 'object' ? Object.values(body.errors) : [];
		const messages = errors.flat().map((e) => (typeof e === 'string' ? e : e && (e.message || e.code))).filter(Boolean);
		if (messages.length) return messages.join(' ');
		if (typeof body.message === 'string' && body.message && body.message !== 'Success') return body.message;
		if (typeof body.error === 'string' && body.error) return body.error;
	}
	return `Pressable API request failed (HTTP ${status})`;
}

/** `data` from a `{ data: [...] }` envelope, or [] when it is missing or not a list. */
const listFrom = (body) => (body && Array.isArray(body.data) ? body.data : Array.isArray(body) ? body : []);

/** `data` from a `{ data: {...} }` envelope, or null. */
const objectFrom = (body) => (body && body.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : null);

/**
 * Thin client for the Pressable API (https://my.pressable.com/documentation/api/v1). An API application's Client ID
 * and Client Secret are traded for a bearer token (OAuth client credentials, valid for an hour), which is renewed
 * when it is about to expire or Pressable rejects it. The API lists the account's sites, their domains and SFTP/SSH
 * users, and purges caches. It can't add SSH keys: those are added by hand in MyPressable. Files and the database
 * move over SSH.
 */
class PressableApi {
	constructor({ clientId, clientSecret, fetchImpl = globalThis.fetch, base = PRESSABLE_API_BASE, logger = console, now = Date.now }) {
		if (!clientId || !clientSecret) throw new PressableApiError('A Pressable API Client ID and Client Secret are required.', 0);
		this._clientId = clientId;
		this._clientSecret = clientSecret;
		this._fetch = fetchImpl;
		this._base = base;
		this._logger = logger;
		this._now = now;
		this._token = null;
		this._tokenExpires = 0;
		/** Name and email of the Pressable user the application belongs to, from the token response. */
		this.owner = null;
	}

	/** Checks the credentials and counts the account's sites: { sites, name, email }. */
	async validate() {
		await this._getToken(true);
		const sites = await this.listSites();
		return { sites: sites.length, name: (this.owner && this.owner.name) || null, email: (this.owner && this.owner.email) || null };
	}

	/**
	 * Every site of the account, all pages: { id, name, displayName, url, staging, sandbox, state, clonedFromId,
	 * sftpDomain, phpVersion, wpEnvironmentType, phpFsPermission, … }.
	 */
	async listSites() {
		const sites = [];
		for (let page = 1; page <= MAX_PAGES; page += 1) {
			const { data } = await this.request('GET', '/v1/sites', { query: { paginate: true, page, per_page: PER_PAGE } });
			const batch = listFrom(data);
			sites.push(...batch);
			const pages = Number(data && data.page && data.page.lastPage);
			if (!batch.length || (Number.isFinite(pages) && pages > 0 ? page >= pages : batch.length < PER_PAGE)) break;
		}
		return sites;
	}

	/** One site, or null when Pressable doesn't know it (deleted, or another account's). */
	async getSite(siteId) {
		try {
			const { data } = await this.request('GET', `/v1/sites/${encodeURIComponent(siteId)}`);
			return objectFrom(data);
		} catch (e) {
			if (e.status === 404) return null;
			throw e;
		}
	}

	/** SFTP/SSH users of a site: [{ id, username, owner, email, sshKeyLabel, sftpDomain }]. */
	async listSftpUsers(siteId) {
		const { data } = await this.request('GET', `/v1/sites/${encodeURIComponent(siteId)}/ftp`);
		return listFrom(data);
	}

	/** A site's domains: [{ domainName, primary, type, … }]. [] on any error: they only add search/replace pairs. */
	async listDomains(siteId) {
		try {
			const { data } = await this.request('GET', `/v1/sites/${encodeURIComponent(siteId)}/domains`);
			return listFrom(data);
		} catch (e) {
			this._logger.warn(`Could not list the Pressable site's domains: ${e.message}`);
			return [];
		}
	}

	/** Purges the site's Edge Cache (Pressable's CDN page cache). */
	async purgeEdgeCache(siteId) {
		await this.request('DELETE', `/v1/sites/${encodeURIComponent(siteId)}/edge-cache`);
	}

	/** Flushes the site's object cache (Memcached). */
	async flushObjectCache(siteId) {
		await this.request('DELETE', `/v1/sites/${encodeURIComponent(siteId)}/object-cache`);
	}

	async _getToken(force = false) {
		if (!force && this._token && this._now() < this._tokenExpires - TOKEN_MARGIN_MS) return this._token;
		const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: this._clientId, client_secret: this._clientSecret });
		let res;
		try {
			res = await this._fetch(`${this._base}/auth/token`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
				body: body.toString(),
			});
		} catch (e) {
			throw this._networkError(e);
		}
		const data = await res.json().catch(() => null);
		if (res.status === 400 || res.status === 401) {
			throw new PressableApiError(`Pressable rejected this Client ID and Client Secret. Check them in ${API_APPLICATIONS_PAGE}, `
				+ 'or create a new application there.', 401, data);
		}
		if (!res.ok || !data || !data.access_token) throw new PressableApiError(errorMessageFrom(data, res.status), res.status, data);
		this._token = data.access_token;
		this._tokenExpires = this._now() + (Number(data.expires_in) || 3600) * 1000;
		this.owner = { name: data.name || null, email: data.email || null };
		return this._token;
	}

	_networkError(e) {
		// fetch() only says "fetch failed" when the network is down or DNS fails; say what that means.
		const cause = e && e.cause && (e.cause.code || e.cause.message);
		return new PressableApiError(`Could not reach Pressable's API (${cause || e.message}). Check your internet connection and try again.`, 0, null);
	}

	async request(method, path, { query, json } = {}, attempt = 0) {
		const url = new URL(`${this._base}${path}`);
		if (query) {
			Object.entries(query).forEach(([k, v]) => {
				if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
			});
		}
		const token = await this._getToken();
		const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
		let body;
		if (json) {
			headers['Content-Type'] = 'application/json';
			body = JSON.stringify(json);
		}
		let res;
		try {
			res = await this._fetch(url.toString(), { method, headers, body });
		} catch (e) {
			throw this._networkError(e);
		}
		const data = await res.json().catch(() => null);
		if (res.status === 429 && attempt < 4) {
			const retryAfter = Number(res.headers && res.headers.get && res.headers.get('retry-after')) || 2 ** attempt * 5;
			this._logger.warn(`Pressable API rate limited; retrying in ${retryAfter}s`);
			await sleep(retryAfter * 1000);
			return this.request(method, path, { query, json }, attempt + 1);
		}
		if (res.status === 401 && attempt === 0) {
			// The token expired early or was revoked: get a new one once.
			this._token = null;
			return this.request(method, path, { query, json }, attempt + 1);
		}
		if (res.status === 401) {
			throw new PressableApiError(`Pressable no longer accepts this API application. Check it in ${API_APPLICATIONS_PAGE}, then connect again.`, 401, data);
		}
		if (res.status === 403) {
			throw new PressableApiError(`This API application isn't allowed to ${method} ${path}. In ${API_APPLICATIONS_PAGE}, give it read access to `
				+ 'Sites, FTP and Domains, and edit access to Sites.', 403, data);
		}
		if (!res.ok) throw new PressableApiError(errorMessageFrom(data, res.status), res.status, data);
		return { status: res.status, data: data || {} };
	}
}

module.exports = { PressableApi, PressableApiError, errorMessageFrom, API_APPLICATIONS_PAGE };
