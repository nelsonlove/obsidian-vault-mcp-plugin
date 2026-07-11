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

describe("repointLinksInText options", () => {
  test("default: echo alias is preserved verbatim (back-compat)", () => {
    assert.equal(repointLinksInText("[[Foo|Foo]]", "Foo", "Bar").text, "[[Bar|Foo]]");
  });

  test("dropEchoAlias removes an alias that echoes the old name", () => {
    const { text, count } = repointLinksInText("[[Foo|Foo]]", "Foo", "Bar", { dropEchoAlias: true });
    assert.equal(text, "[[Bar]]");
    assert.equal(count, 1);
  });

  test("dropEchoAlias matches the echo case-insensitively and trimmed", () => {
    assert.equal(repointLinksInText("[[Foo|FOO]]", "Foo", "Bar", { dropEchoAlias: true }).text, "[[Bar]]");
    assert.equal(repointLinksInText("[[Foo| foo ]]", "Foo", "Bar", { dropEchoAlias: true }).text, "[[Bar]]");
  });

  test("dropEchoAlias keeps a genuine display alias", () => {
    assert.equal(
      repointLinksInText("[[Foo|see the discussion]]", "Foo", "Bar", { dropEchoAlias: true }).text,
      "[[Bar|see the discussion]]",
    );
  });

  test("dropEchoAlias keeps subpath while dropping echo alias", () => {
    assert.equal(repointLinksInText("[[Foo#H|Foo]]", "Foo", "Bar", { dropEchoAlias: true }).text, "[[Bar#H]]");
  });

  test("allowTarget=false leaves the link untouched and uncounted", () => {
    const { text, count } = repointLinksInText("[[Foo]]", "Foo", "Bar", { allowTarget: () => false });
    assert.equal(text, "[[Foo]]");
    assert.equal(count, 0);
  });

  test("allowTarget gates per link and receives the raw target text", () => {
    const seen = [];
    const { text, count } = repointLinksInText(
      "[[Foo]] and [[ Foo ]]",
      "Foo",
      "Bar",
      { allowTarget: (raw) => { seen.push(raw); return raw === "Foo"; } },
    );
    assert.equal(text, "[[Bar]] and [[ Foo ]]");
    assert.equal(count, 1);
    assert.deepEqual(seen, ["Foo", " Foo "]);
  });

  test("allowTarget and dropEchoAlias compose", () => {
    const { text } = repointLinksInText("[[Foo|Foo]] [[Foo|keep]]", "Foo", "Bar", {
      dropEchoAlias: true,
      allowTarget: () => true,
    });
    assert.equal(text, "[[Bar]] [[Bar|keep]]");
  });
});
