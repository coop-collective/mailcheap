import { isValidObjectId } from "@/lib/d1-id";
import { notFound } from "next/navigation";
import AvatarNewsletter from "@/components/AvatarNewsletter";
import FormNewsletter from "@/components/FormNewsletter";
import HeaderPage from "@/components/HeaderPage";
import { cleanupTotalsPipeline } from "@/lib/cleanup";
import { isSendingEnabled } from "@/lib/config";
import { connectDb } from "@/lib/db";
import { serialize } from "@/lib/serialize";
import { listEmailDomains } from "@/lib/email";
import Contact from "@/models/Contact";
import Newsletter from "@/models/Newsletter";

export const metadata = { title: "Newsletter" };

export default async function NewsletterPage({ params }) {
	const { id } = await params;
	const isNew = id === "new";
	if (!isNew && !isValidObjectId(id)) notFound();

	await connectDb();
	const [newsletter, domains, cleanupTotals] = await Promise.all([
		isNew ? null : Newsletter.findById(id).lean(),
		listEmailDomains(),
		isNew ? null : getCleanupTotals(id),
	]);
	if (!isNew && !newsletter) notFound();

	const verifiedDomains = Array.isArray(domains)
		? domains.filter(({ verified }) => verified).map(({ domain }) => domain)
		: null;

	return (
		<>
			<HeaderPage
				title={isNew ? "New newsletter" : newsletter.name}
				backHref="/newsletters"
				icon={newsletter && <AvatarNewsletter newsletter={newsletter} size={32} />}
			/>
			<FormNewsletter
				newsletter={newsletter ? serialize(newsletter) : null}
				verifiedDomains={verifiedDomains}
				isSendingEnabled={isSendingEnabled()}
				testEmail={process.env.ADMIN_EMAIL}
				cleanupTotals={cleanupTotals}
			/>
		</>
	);
}

async function getCleanupTotals(newsletterId) {
	const [totals] = await Contact.aggregate(cleanupTotalsPipeline(newsletterId));
	return { waiting: totals?.waiting ?? 0, kept: totals?.kept ?? 0, dormant: totals?.dormant ?? 0 };
}
