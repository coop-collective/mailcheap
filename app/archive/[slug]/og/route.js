import geistRegularUrl from "@/assets/fonts/Geist-Regular.ttf?inline";
import geistSemiBoldUrl from "@/assets/fonts/Geist-SemiBold.ttf?inline";
import { ImageResponse } from "next/og";
import { countReaders, getArchiveIssue, getArchiveNewsletter } from "@/lib/archive-data";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { getIssueDate } from "@/lib/archive-issues";
import { SHARE_IMAGE_SIZE } from "@/lib/archive-seo";
import { getAppUrl } from "@/lib/config";
import { formatDate, formatNumber } from "@/lib/format";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { readBoundedBody } from "@/lib/request-body";

const FONTS = [
	{ name: "Geist", data: Buffer.from(geistRegularUrl.split(",")[1], "base64"), weight: 400, style: "normal" },
	{ name: "Geist", data: Buffer.from(geistSemiBoldUrl.split(",")[1], "base64"), weight: 600, style: "normal" },
];
const COLORS = { foreground: "#0a0a0a", muted: "#737373", border: "#e5e5e5" };

async function loadImage(url) {
	const buffer = await (async () => {
		const target = new URL(url, getAppUrl());
		let response;
		if (target.origin === new URL(getAppUrl()).origin) {
			const { ASSETS, IMAGES } = await getCloudflareEnv();
			if (target.pathname.startsWith("/media/images/")) {
				const object = await IMAGES.get(target.pathname.slice("/media/".length));
				if (!object || object.size > 4 * 1024 * 1024) return null;
				response = new Response(object.body);
			} else {
				response = await ASSETS.fetch(target);
			}
		} else {
			response = await fetch(target, { signal: AbortSignal.timeout(5000) });
		}
		return response.ok ? Buffer.from(await readBoundedBody(response, 4 * 1024 * 1024)) : null;
	})().catch(() => null);
	if (!buffer) return null;
	const type = buffer[0] === 0x89 && buffer[1] === 0x50 ? "png" : buffer[0] === 0xff && buffer[1] === 0xd8 ? "jpeg" : null;
	return type && `data:image/${type};base64,${buffer.toString("base64")}`;
}

// The card renderer can't decode WebP, so a WebP logo uses the PNG saved next to it.
async function readLogo(imageUrl) {
	if (!imageUrl) return null;
	return (await loadImage(imageUrl.replace(/\.webp$/i, ".png"))) ?? loadImage(imageUrl);
}

// Each issue gets its own soft tint, so archive cards stand out from the page and a row of them
// doesn't look like one card repeated.
function issueBackground(slug) {
	let hue = 0;
	for (const character of slug) hue = (hue * 31 + character.codePointAt(0)) % 360;
	return `linear-gradient(135deg, hsl(${hue}, 85%, 96%), hsl(${(hue + 45) % 360}, 75%, 89%))`;
}

// Share card for the archive home, and for issues that have no thumbnail of their own.
export async function GET(request, { params }) {
	const { slug } = await params;
	const newsletter = await getArchiveNewsletter(slug);
	if (!newsletter) return new Response("Not found", { status: 404 });

	const postSlug = new URL(request.url).searchParams.get("p");
	const issue = postSlug ? await getArchiveIssue(newsletter._id.toString(), postSlug) : null;
	if (postSlug && !issue) return new Response("Not found", { status: 404 });

	const [logo, readers] = await Promise.all([readLogo(newsletter.imageUrl), countReaders(newsletter._id.toString())]);
	const domain = new URL(getArchiveUrls(newsletter, undefined, getAppUrl()).siteIndex).host;
	const footer = issue ? formatDate(getIssueDate(issue)) : readers >= 100 ? `Join ${formatNumber(readers)} readers` : "";

	return new ImageResponse(
		<div
			style={{
				width: "100%",
				height: "100%",
				display: "flex",
				flexDirection: "column",
				justifyContent: "space-between",
				padding: 72,
				backgroundColor: "#ffffff",
				...(issue && { backgroundImage: issueBackground(issue.archiveSlug) }),
				fontFamily: "Geist",
				color: COLORS.foreground,
			}}
		>
			<div style={{ display: "flex", alignItems: "center", gap: 20 }}>
				{logo && (
					// eslint-disable-next-line @next/next/no-img-element -- ImageResponse renders plain <img>
					<img
						src={logo}
						width={issue ? 64 : 112}
						height={issue ? 64 : 112}
						style={{ borderRadius: issue ? 16 : 28, border: `1px solid ${COLORS.border}` }}
						alt=""
					/>
				)}
				{issue && <span style={{ fontSize: 32, fontWeight: 600 }}>{newsletter.name}</span>}
			</div>

			<div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 1000 }}>
				<span
					style={{
						fontSize: issue ? 64 : 88,
						fontWeight: 600,
						lineHeight: 1.08,
						letterSpacing: issue ? -2 : -3,
					}}
				>
					{issue ? issue.subject : newsletter.name}
				</span>
				{(issue ? issue.previewText : newsletter.description) && (
					<span style={{ fontSize: 32, lineHeight: 1.35, color: COLORS.muted }}>
						{issue ? issue.previewText : newsletter.description}
					</span>
				)}
			</div>

			<div style={{ display: "flex", justifyContent: "space-between", fontSize: 28, color: COLORS.muted }}>
				<span>{footer}</span>
				<span>{domain}</span>
			</div>
		</div>,
		{
			...SHARE_IMAGE_SIZE,
			fonts: FONTS,
			headers: { "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800" },
		}
	);
}
