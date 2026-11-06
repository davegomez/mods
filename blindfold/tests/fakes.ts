import type { EngineInterface, On } from "claude-code";

/** Fake secrets for tests. Each token is joined at run time, so no file holds a full token shape. */

/** A seeded generator (mulberry32), so every run sees the same values. */
export function random(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export const BASE62 =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
export const URL_SAFE = `${BASE62}_-`;
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const DIGITS = "0123456789";
const BASE64 = `${BASE62}+/`;

export function chars(
	next: () => number,
	length: number,
	alphabet = BASE62,
): string {
	let out = "";
	for (let i = 0; i < length; i++) {
		out += alphabet[Math.floor(next() * alphabet.length)];
	}
	return out;
}

const join = (...parts: string[]) => parts.join("");

export const base64url = (text: string) =>
	btoa(text).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

export function fakes(seed = 1) {
	const next = random(seed);
	const body = (n: number, alphabet?: string) => chars(next, n, alphabet);
	const jwt = [
		base64url(JSON.stringify({ alg: "HS256", typ: "JWT" })),
		base64url(JSON.stringify({ sub: body(12), iat: 1_700_000_000 })),
		body(43, URL_SAFE),
	].join(".");
	const pemBody = Array.from({ length: 4 }, () => body(64, BASE64)).join("\n");
	const pem = (label: string) =>
		join("-----BEGIN ", label, "PRIVATE KEY", "-----\n", pemBody, "\n");
	const pemEnd = (label: string) =>
		join("-----END ", label, "PRIVATE KEY-----");
	return {
		githubClassic: join("gh", "p_", body(36)),
		githubOauth: join("gh", "o_", body(36)),
		githubPat: join("github", "_pat_", body(22), "_", body(59)),
		githubStateless: join("gh", "s_", body(7, DIGITS), "_", jwt),
		stripeSecret: join("sk", "_live_", body(24)),
		stripeRestricted: join("rk", "_test_", body(99)),
		anthropic: join("sk-", "ant-", "api03-", body(93, URL_SAFE)),
		openai: join("sk-", "proj-", body(48, URL_SAFE)),
		openaiLegacy: join("sk-", body(48)),
		slackBot: join("xo", "xb-", body(12, DIGITS), "-", body(24)),
		slackUser: join("xo", "xp-", body(12, DIGITS), "-", body(32)),
		slackRefresh: join("xo", "xe-1-", body(140)),
		slackApp: join(
			"xa",
			"pp-1-",
			body(11, UPPER),
			"-",
			body(13, DIGITS),
			"-",
			body(64, "0123456789abcdef"),
		),
		aws: join("AK", "IA", body(16, UPPER)),
		awsTemporary: join("AS", "IA", body(16, UPPER)),
		google: join("AI", "za", body(35, URL_SAFE)),
		npm: join("np", "m_", body(36)),
		jwt,
		privateKey: (label = "RSA ") => join(pem(label), pemEnd(label)),
		privateKeyOpen: (label = "") => pem(label),
		secret: (n = 32) => body(n),
		hex: (n: number) => body(n, "0123456789abcdef"),
		base64: (n: number) => body(n, BASE64),
	};
}

/** The session root the fake `$` answers, and where it resolves to. */
export const ROOT = "/repo";
export const REAL_ROOT = "/private/repo";

/** 1 path under the fake root, as the fake `$.fs` answers for it. */
export type FakeFile = {
	text?: string;
	kind?: "file" | "dir" | "other";
	size?: number;
	isLink?: boolean;
	/** Where the path lands; `null` when it leads nowhere. Default: under `REAL_ROOT`. */
	realPath?: string | null;
	statFails?: boolean;
	readFails?: boolean;
	/** The read answers only once this settles. */
	gate?: Promise<void>;
};

export type FakeSet = { key: string; value: unknown };

/**
 * A hand-made `$` over `files`, keyed by their path under the root. The test's own `$` cannot make these calls:
 * the host allows a `$` call only to the module whose source spells it.
 */
export function fakeApi(
	files: Record<string, FakeFile>,
	options: { realRoot?: string | null; setAnswer?: { deny: string } } = {},
) {
	const realRoot =
		options.realRoot === undefined ? REAL_ROOT : options.realRoot;
	const reads: string[] = [];
	const sets: FakeSet[] = [];
	const base = realRoot ?? REAL_ROOT;
	const under = (path: string) =>
		path.startsWith(`${base}/`) ? path.slice(base.length + 1) : "";
	const real = (rel: string, file: FakeFile) =>
		file.realPath === undefined ? `${base}/${rel}` : file.realPath;
	const stat = async (path: string, opts?: { resolve: boolean }) => {
		const found =
			path === ROOT
				? { kind: "dir" as const, isLink: false, size: 0, realPath: realRoot }
				: undefined;
		const rel = under(path);
		const file = files[rel];
		if (!found && !file) throw new Error(`ENOENT: stat '${path}'`);
		if (file?.statFails) throw new Error(`EACCES: stat '${path}'`);
		const realPath = found ? found.realPath : real(rel, file as FakeFile);
		return {
			kind: found?.kind ?? file?.kind ?? "file",
			size:
				found?.size ??
				file?.size ??
				new TextEncoder().encode(file?.text ?? "").length,
			mtimeMs: 0,
			isLink: found?.isLink ?? file?.isLink ?? false,
			...(realPath === null || !opts?.resolve ? {} : { realPath }),
		};
	};
	const api = {
		session: { root: async () => ROOT },
		fs: {
			stat,
			exists: async (path: string) => under(path) in files,
			read: async (path: string) => {
				reads.push(path);
				const file = Object.entries(files).find(
					([rel, f]) => real(rel, f) === path,
				)?.[1];
				await file?.gate;
				if (!file || file.readFails || file.text === undefined) {
					throw new Error(`EIO: read '${path}'`);
				}
				return file.text;
			},
		},
		config: {
			set: async ({ key, value }: FakeSet) => {
				sets.push({ key, value });
				return options.setAnswer ?? { value };
			},
		},
	} as unknown as EngineInterface;
	return { api, reads, sets };
}

/** Answers the mod's own `$.session.root` and `$.fs` calls with kit stubs over a fake `$`, for tests that fire the mod's hooks. */
export function stubFs(on: On, api: EngineInterface): void {
	const answer = <T>(
		call: () => Promise<T>,
	): Promise<{ value: T } | { deny: string }> =>
		call().then(
			(value) => ({ value }),
			(error: Error) => ({ deny: error.message }),
		);
	on("session.root", () => answer(() => api.session.root()));
	on("fs.stat", (_$, e) =>
		answer(() => api.fs.stat(e.path, { resolve: e.resolve })),
	);
	on("fs.exists", (_$, e) => answer(() => api.fs.exists(e.path)));
	on("fs.read", (_$, e) => answer(() => api.fs.read(e.path)));
}

/** A promise and the function that settles it. */
export function gate(): { wait: Promise<void>; open: () => void } {
	let open = () => {};
	const wait = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { wait, open };
}
