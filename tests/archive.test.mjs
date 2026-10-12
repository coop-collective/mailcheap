import assert from "node:assert/strict";
import { test } from "node:test";
import { getArchiveHostUrl, getArchiveSlugForHost, getArchiveUrls, parseArchiveHosts } from "../lib/archive-hosts.js";
import { getShareLinks, getSocialPlatform, parseSocialLinks } from "../lib/social.js";

test("app-domain archive paths move to the newsletter's own domain when it has one", () => {
	const value = "news.example.com=weekly,letters.example.org=monthly";
	const cases = [
		["/archive/weekly", "", "https://news.example.com/"],
		["/archive/weekly/", "", "https://news.example.com/"],
		["/archive/weekly/p/my-issue", "?ref=x", "https://news.example.com/p/my-issue?ref=x"],
		["/archive/monthly/authors/jane-doe", "", "https://letters.example.org/authors/jane-doe"],
		["/archive/monthly/sitemap", "", "https://letters.example.org/sitemap.xml"],
		["/archive/monthly/robots", "", "https://letters.example.org/robots.txt"],
	];
	for (const [pathname, search, expected] of cases) assert.equal(getArchiveHostUrl(pathname, search, value), expected, pathname);
	assert.equal(getArchiveHostUrl("/archive/no-domain/p/x", "", value), null, "no domain: the archive stays on the app");
	assert.equal(getArchiveHostUrl("/archive/weekly/p/x", "", ""), null);
	assert.equal(getArchiveHostUrl("/campaigns", "", value), null);
});

test("archive hosts map domains to newsletter slugs", () => {
	const value = " news.example.com = weekly ,bad, letters.example.org=Monthly";
	assert.deepEqual([...parseArchiveHosts(value)], [
		["news.example.com", "weekly"],
		["letters.example.org", "monthly"],
	]);
	assert.equal(getArchiveSlugForHost("News.Example.com:443", value), "weekly");
	assert.equal(getArchiveSlugForHost("mailcheap.example.com", value), null);
	assert.equal(getArchiveSlugForHost(null, ""), null);
});

test("archive links use the newsletter's domain once it routes here", () => {
	const value = "news.example.com=weekly";
	const own = getArchiveUrls({ slug: "weekly" }, value, "https://app.test");
	assert.equal(own.host, "news.example.com");
	assert.equal(own.index, "https://news.example.com/");
	assert.equal(own.siteIndex, "https://news.example.com/");
	assert.equal(own.post("issue-1"), "https://news.example.com/p/issue-1");
	assert.equal(own.absolutePost("issue-1"), "https://news.example.com/p/issue-1");
	assert.equal(own.author("jane-doe"), "https://news.example.com/authors/jane-doe");
	assert.equal(own.absoluteAuthor("jane-doe"), "https://news.example.com/authors/jane-doe");

	const app = getArchiveUrls({ slug: "monthly" }, value, "https://app.test");
	assert.equal(app.host, null);
	assert.equal(app.index, "/archive/monthly");
	assert.equal(app.post("issue-2"), "/archive/monthly/p/issue-2");
	assert.equal(app.author("jane-doe"), "/archive/monthly/authors/jane-doe");
	assert.equal(app.siteIndex, "https://app.test/archive/monthly");
	assert.equal(app.absolutePost("issue-2"), "https://app.test/archive/monthly/p/issue-2", "emails need the full URL");
	assert.equal(app.absoluteAuthor("jane-doe"), "https://app.test/archive/monthly/authors/jane-doe");
});

test("social links are recognized by their domain", () => {
	assert.equal(getSocialPlatform("https://twitter.com/example").id, "x");
	assert.equal(getSocialPlatform("https://www.linkedin.com/in/example/").id, "linkedin");
	assert.equal(getSocialPlatform("https://m.youtube.com/@example").id, "youtube");
	assert.deepEqual(getSocialPlatform("https://www.example.com"), {
		id: "website",
		label: "example.com",
		domain: "example.com",
	});
	assert.equal(getSocialPlatform("not a link"), null);
});

test("social links are one https link per line", () => {
	assert.deepEqual(parseSocialLinks(" https://x.com/example\n\nhttps://x.com/example https://youtube.com/@example "), {
		links: ["https://x.com/example", "https://youtube.com/@example"],
	});
	assert.match(parseSocialLinks("http://x.com/example").error, /not an https/);
	assert.match(parseSocialLinks("javascript:alert(1)").error, /not an https/);
	assert.match(parseSocialLinks(Array.from({ length: 9 }, (_, i) => `https://a${i}.com`).join("\n")).error, /at most 8/);
});

test("share links carry the issue URL", () => {
	const [x, linkedin] = getShareLinks({ url: "https://news.example.com/p/a b", text: "Hi & bye" });
	assert.equal(x.href, "https://x.com/intent/post?text=Hi%20%26%20bye&url=https%3A%2F%2Fnews.example.com%2Fp%2Fa%20b");
	assert.equal(linkedin.href, "https://www.linkedin.com/sharing/share-offsite/?url=https%3A%2F%2Fnews.example.com%2Fp%2Fa%20b");
});
