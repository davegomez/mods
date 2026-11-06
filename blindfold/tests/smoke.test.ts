import type { On } from "claude-code";
import { describe, expect, test } from "claude-code/testing";
import { register } from "../hooks/register.ts";

describe("register", () => {
	test("adds no hooks", () => {
		let calls = 0;
		const on = (() => {
			calls += 1;
		}) as unknown as On;
		register(on, {});
		expect(calls).toBe(0);
	});
});
