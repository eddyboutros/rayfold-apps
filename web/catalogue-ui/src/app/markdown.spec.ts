import { render } from "./markdown";

describe("render", () => {
  it("escapes every character HTML would read before adding its own markup", () => {
    expect(render('<script>"x" & y</script>')).toBe("<p>&lt;script&gt;&quot;x&quot; &amp; y&lt;/script&gt;</p>");
    expect(render("**<b>**")).toBe("<p><strong>&lt;b&gt;</strong></p>");
  });

  it("turns headings of one to four marks into their level, and leaves a fifth as prose", () => {
    expect(render("# One\n## Two\n### Three\n#### Four")).toBe("<h1>One</h1>\n<h2>Two</h2>\n<h3>Three</h3>\n<h4>Four</h4>");
    expect(render("##### Five")).toBe("<p>##### Five</p>");
    expect(render("#NoSpace")).toBe("<p>#NoSpace</p>");
  });

  it("reads emphasis, strong and code inline", () => {
    expect(render("a *b* **c** `d*e*`")).toBe("<p>a <em>b</em> <strong>c</strong> <code>d<em>e</em></code></p>");
    expect(render("*start*")).toBe("<p><em>start</em></p>");
  });

  it("joins a paragraph's lines and ends it at a blank line, a heading, a list or a table", () => {
    expect(render("one\ntwo\r\n\r\nthree")).toBe("<p>one two</p>\n<p>three</p>");
    expect(render("# Head\r\n- item\r\n| a |\r\n")).toBe("<h1>Head</h1>\n<ul><li>item</li></ul>\n<table><thead><tr><th>a</th></tr></thead><tbody></tbody></table>");
    expect(render("para\n# Head")).toBe("<p>para</p>\n<h1>Head</h1>");
    expect(render("para\n- item")).toBe("<p>para</p>\n<ul><li>item</li></ul>");
    expect(render("para\n| a |")).toBe("<p>para</p>\n<table><thead><tr><th>a</th></tr></thead><tbody></tbody></table>");
  });

  it("makes bullet and numbered lists, with indented lines continuing an item", () => {
    expect(render("- one\n* two\n  more of two\n- three")).toBe("<ul><li>one</li><li>two more of two</li><li>three</li></ul>");
    expect(render("1. first\n2. second")).toBe("<ol><li>first</li><li>second</li></ol>");
    expect(render("- a\n\n1. b")).toBe("<ul><li>a</li></ul>\n<ol><li>b</li></ol>");
  });

  it("makes a table of a header row and body rows, dropping the divider", () => {
    expect(render("| Name | *Role* |\n| --- | --- |\n| Ada | Lead |\n| Lin | Eng |")).toBe(
      "<table><thead><tr><th>Name</th><th><em>Role</em></th></tr></thead><tbody><tr><td>Ada</td><td>Lead</td></tr><tr><td>Lin</td><td>Eng</td></tr></tbody></table>",
    );
  });

  it("renders nothing for blank text", () => {
    expect(render("")).toBe("");
    expect(render("\n  \n")).toBe("");
  });
});
