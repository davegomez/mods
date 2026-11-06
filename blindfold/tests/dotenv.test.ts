import { describe, expect, test } from "claude-code/testing";
import { parseExpected } from "./dotenv-expected.ts";

describe("dotenv expected results", () => {
	test("A=1 parses to { A: '1' }", () => {
		const found = parseExpected.find((c) => c.input === "A=1");
		expect(found?.output).toEqual({ A: "1" });
	});
});
