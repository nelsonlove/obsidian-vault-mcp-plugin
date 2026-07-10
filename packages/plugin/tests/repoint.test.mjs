import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { repointLinksInText, normalizeLinkName } from "../src/mcp/repoint.ts";

describe("repointLinksInText", () => {
  test("repoints a bare wikilink and counts it", () => {
    const { text, count } = repointLinksInText("see [[Foo]] here", "Foo", "Bar");
    assert.equal(text, "see [[Bar]] here");
    assert.equal(count, 1);
  });

  test("preserves an alias", () => {
    const { text, count } = repointLinksInText("[[Foo|the display]]", "Foo", "Bar");
    assert.equal(text, "[[Bar|the display]]");
    assert.equal(count, 1);
  });

  test("preserves a subpath (heading / block ref)", () => {
    assert.equal(repointLinksInText("[[Foo#Heading]]", "Foo", "Bar").text, "[[Bar#Heading]]");
    assert.equal(repointLinksInText("[[Foo#^blk]]", "Foo", "Bar").text, "[[Bar#^blk]]");
  });

  test("preserves subpath and alias together", () => {
    assert.equal(repointLinksInText("[[Foo#H|d]]", "Foo", "Bar").text, "[[Bar#H|d]]");
  });

  test("matches case-insensitively", () => {
    assert.equal(repointLinksInText("[[foo]]", "Foo", "Bar").count, 1);
    assert.equal(repointLinksInText("[[FOO]]", "foo", "Bar").count, 1);
  });

  test("trims surrounding whitespace in the link target", () => {
    const { text, count } = repointLinksInText("[[ Foo ]]", "Foo", "Bar");
    assert.equal(text, "[[Bar]]");
    assert.equal(count, 1);
  });

  test("leaves non-matching links untouched (no substring match)", () => {
    const { text, count } = repointLinksInText("[[Foobar]] and [[Barfoo]]", "Foo", "Bar");
    assert.equal(text, "[[Foobar]] and [[Barfoo]]");
    assert.equal(count, 0);
  });

  test("repoints multiple occurrences and reports the count", () => {
    const { text, count } = repointLinksInText("[[Foo]] x [[Foo|y]] x [[Foo#z]]", "Foo", "Bar");
    assert.equal(text, "[[Bar]] x [[Bar|y]] x [[Bar#z]]");
    assert.equal(count, 3);
  });

  test("only touches the matching target, not other links", () => {
    const { text, count } = repointLinksInText("[[Foo]] [[Other]]", "Foo", "Bar");
    assert.equal(text, "[[Bar]] [[Other]]");
    assert.equal(count, 1);
  });

  test("supports a path-shaped newTarget", () => {
    assert.equal(
      repointLinksInText("[[Foo]]", "Foo", "Notes/Sub/Bar").text,
      "[[Notes/Sub/Bar]]",
    );
  });

  test("count is 0 when nothing matches (dry-run safety)", () => {
    assert.equal(repointLinksInText("no links here", "Foo", "Bar").count, 0);
  });
});

describe("normalizeLinkName", () => {
  test("trims and lowercases", () => {
    assert.equal(normalizeLinkName("  Foo Bar  "), "foo bar");
  });
});
