import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { NodeViewProps } from "@tiptap/react";
import { BookmarkView } from "./bookmark";

/**
 * B136 — the stored bookmark `embed` markup was framed without the oEmbed
 * allowlist: `embedSrc` pulled the `src` out of the stored value with a
 * regex and framed it as it was. The allowlist only ran when the card was
 * *created*, and the write paths (the server actions, the MCP
 * `append_blocks` tool) store the markup as it is, so any host could be
 * framed inside the app.
 *
 * These are render-level tests: the editor's bookmark node view is rendered
 * with a stored `attrs.embed` and the produced markup is inspected.
 */

/** The `src` of every frame the rendered markup carries. */
const frameSrcsOf = (html: string): string[] =>
  [...html.matchAll(/<iframe\b[^>]*\bsrc="([^"]*)"/g)].map((match) =>
    // The markup carries the src HTML-escaped; decode it the way a browser does.
    match[1].replace(/&amp;/g, "&").replace(/&quot;/g, '"'),
  );

/** Render the editor's bookmark node view with a stored `attrs.embed`. */
const renderView = (attrs: Record<string, unknown>): string =>
  renderToStaticMarkup(
    createElement(BookmarkView, {
      node: { attrs },
      editor: { isEditable: false },
      updateAttributes: () => {},
      deleteNode: () => {},
      selected: false,
      locale: "en",
    } as unknown as NodeViewProps & { locale: string }),
  );

describe("bookmark card — a stored embed is checked against the oEmbed allowlist", () => {
  it("does not frame a host outside the allowlist", () => {
    const html = renderView({
      url: "https://example.com/article",
      embed: '<iframe src="https://attacker.example/"></iframe>',
    });
    expect(frameSrcsOf(html)).toEqual([]);
    expect(html).not.toContain("attacker.example");
  });

  it("does not frame a look-alike host of an allowed provider", () => {
    const html = renderView({
      url: "https://example.com/article",
      embed: '<iframe src="https://youtube.com.attacker.example/embed/abc"></iframe>',
    });
    expect(frameSrcsOf(html)).toEqual([]);
  });

  it("does not frame a non-http(s) src", () => {
    for (const src of ["javascript:alert(1)", "//attacker.example/embed", "/embed/abc"]) {
      const html = renderView({
        url: "https://example.com/article",
        embed: `<iframe src="${src}"></iframe>`,
      });
      expect(frameSrcsOf(html), src).toEqual([]);
    }
  });

  it("frames an allow-listed provider embed", () => {
    const html = renderView({
      url: "https://www.youtube.com/watch?v=abc",
      embed: '<iframe src="https://www.youtube.com/embed/abc"></iframe>',
    });
    expect(frameSrcsOf(html)).toEqual(["https://www.youtube.com/embed/abc"]);
    expect(html).toContain('sandbox="allow-scripts allow-same-origin"');
  });

  it("keeps the entity-encoded src of a stored embed readable", () => {
    const html = renderView({
      url: "https://www.youtube.com/watch?v=abc",
      embed: '<iframe src="https://www.youtube.com/embed/abc?feature=oembed&amp;rel=0"></iframe>',
    });
    expect(frameSrcsOf(html)).toEqual([
      "https://www.youtube.com/embed/abc?feature=oembed&rel=0",
    ]);
  });

  it("does not frame a stored embed that is not an iframe", () => {
    const html = renderView({
      url: "https://example.com/article",
      embed: '<div src="https://attacker.example/"></div>',
    });
    expect(frameSrcsOf(html)).toEqual([]);
  });
});
