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
