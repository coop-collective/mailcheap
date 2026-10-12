import crypto from "node:crypto";
import { Suspense } from "react";
import Link from "next/link";
import { isValidObjectId } from "@/lib/d1-id";
import { ChevronLeft, ChevronRight, Users } from "lucide-react";
import AvatarContact from "@/components/AvatarContact";
import AvatarNewsletter from "@/components/AvatarNewsletter";
import BadgeStatus from "@/components/BadgeStatus";
import DialogImportContacts from "@/components/DialogImportContacts";
import FilterContacts from "@/components/FilterContacts";
import HeaderPage from "@/components/HeaderPage";
import MenuContact from "@/components/MenuContact";
import StateEmpty from "@/components/StateEmpty";
import TextEmpty from "@/components/TextEmpty";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { connectDb } from "@/lib/db";
import { formatDate, formatNumber } from "@/lib/format";
import { NEWSLETTER_SUMMARY_FIELDS, toNewsletterMap, toNewsletterOptions } from "@/lib/newsletters";
import { cn } from "@/lib/utils";
import Contact, { CONTACT_STATUSES } from "@/models/Contact";
import Newsletter from "@/models/Newsletter";

export const metadata = { title: "Contacts" };

const PAGE_SIZE = 50;

export default async function ContactsPage({ searchParams }) {
	const params = await searchParams;
	const newsletterId = isValidObjectId(params.newsletter) ? params.newsletter : null;
	const status = CONTACT_STATUSES.includes(params.status) ? params.status : null;
	const query = typeof params.q === "string" ? params.q.trim().toLowerCase().slice(0, 254) : "";
	const page = Math.max(1, Number.parseInt(params.page, 10) || 1);

	await connectDb();
	const newsletters = await Newsletter.find().sort({ createdAt: 1 }).select(NEWSLETTER_SUMMARY_FIELDS).lean();
	const newsletterOptions = toNewsletterOptions(newsletters);
	const newsletterMap = toNewsletterMap(newsletters);

	const baseFilter = {
		...(newsletterId && { newsletterId: newsletterId }),
		...(query && { email: { $regex: `^${escapeRegex(query)}` } }),
	};
	const filter = { ...baseFilter, ...(status && { status }) };

	// One count per status reads only the status indexes; grouping the contacts would read every one.
	const [statusCounts, contacts] = await Promise.all([
		Promise.all(CONTACT_STATUSES.map((key) => Contact.countDocuments({ ...baseFilter, status: key }))),
		Contact.find(filter)
			.sort({ subscribedAt: -1, _id: -1 })
			.skip((page - 1) * PAGE_SIZE)
			.limit(PAGE_SIZE)
			.lean(),
	]);
	const counts = Object.fromEntries(CONTACT_STATUSES.map((key, index) => [key, statusCounts[index]]));
	const totalAll = statusCounts.reduce((sum, count) => sum + count, 0);
	const total = status ? counts[status] || 0 : totalAll;
	const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

	function href(changes) {
		const next = new URLSearchParams(
			Object.entries({ newsletter: newsletterId, status, q: query, page }).filter(([, value]) => value)
		);
		for (const [key, value] of Object.entries(changes)) {
			if (value) next.set(key, value);
			else next.delete(key);
		}
		if (next.get("page") === "1") next.delete("page");
		return `/contacts${next.size ? `?${next}` : ""}`;
	}

	return (
		<>
			<HeaderPage title="Contacts">
				<DialogImportContacts newsletters={newsletterOptions} defaultNewsletterId={newsletterId} />
			</HeaderPage>

			<div className="flex flex-col gap-4">
				<Suspense fallback={<Skeleton className="h-9 w-full rounded-lg" />}>
					<FilterContacts newsletters={newsletterOptions} />
				</Suspense>

				<nav
					aria-label="Status"
					className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 animate-enter [scrollbar-width:none]"
				>
					{[null, ...CONTACT_STATUSES].map((key) => {
						const isActive = key === status;
						return (
							<Link
								key={key ?? "all"}
								href={href({ status: key, page: null })}
								scroll={false}
								aria-current={isActive ? "page" : undefined}
								className={cn(
									"inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-sm transition-[color,background-color,box-shadow] duration-150",
									isActive
										? "bg-foreground text-background"
										: "text-muted-foreground hover:bg-muted hover:text-foreground"
								)}
							>
								{key ? key.charAt(0).toUpperCase() + key.slice(1) : "All"}
								<span className={cn("text-xs tabular-nums", isActive ? "opacity-70" : "opacity-60")}>
									{formatNumber(key ? counts[key] || 0 : totalAll)}
								</span>
							</Link>
						);
					})}
				</nav>

				{contacts.length === 0 ? (
					<StateEmpty icon={Users} title={totalAll ? "No contacts match" : "No contacts yet"} />
				) : (
					<div style={{ "--stagger": 1 }} className="overflow-hidden rounded-xl shadow-border animate-enter">
						<Table>
							<TableHeader>
								<TableRow className="hover:bg-transparent">
									<TableHead className="pl-4">Email</TableHead>
									<TableHead>Status</TableHead>
									{!newsletterId && <TableHead className="hidden md:table-cell">Newsletter</TableHead>}
									<TableHead className="hidden text-right lg:table-cell">Opens</TableHead>
									<TableHead className="hidden text-right lg:table-cell">Clicks</TableHead>
									<TableHead className="hidden text-right sm:table-cell">Added</TableHead>
									<TableHead className="w-12 pr-2" />
								</TableRow>
							</TableHeader>
							<TableBody>
								{contacts.map((contact) => (
									<TableRow key={contact._id.toString()} className="tabular-nums">
										<TableCell className="max-w-0 py-2.5 pl-4 font-medium sm:w-2/5">
											<span className="flex min-w-0 items-center gap-2.5">
												<AvatarContact
													email={contact.email}
													gravatarHash={gravatarHash(contact.email)}
													size={26}
												/>
												<span className="truncate">{contact.email}</span>
											</span>
										</TableCell>
										<TableCell>
											<BadgeStatus status={contact.status} />
										</TableCell>
										{!newsletterId && (
											<TableCell className="hidden text-muted-foreground md:table-cell">
												<span className="flex items-center gap-2">
													<AvatarNewsletter newsletter={newsletterMap[contact.newsletterId.toString()]} size={18} />
													<span className="truncate">{newsletterMap[contact.newsletterId.toString()]?.name}</span>
												</span>
											</TableCell>
										)}
										<TableCell className="hidden text-right lg:table-cell">
											{engagement(contact, "opens", "openRate")}
										</TableCell>
										<TableCell className="hidden text-right lg:table-cell">
											{engagement(contact, "clicks", "clickRate")}
										</TableCell>
										<TableCell className="hidden text-right text-muted-foreground sm:table-cell">
											{formatDate(contact.subscribedAt) ?? <TextEmpty />}
										</TableCell>
										<TableCell className="pr-2 text-right">
											<MenuContact id={contact._id.toString()} status={contact.status} />
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</div>
				)}

				{pageCount > 1 && (
					<div className="flex items-center justify-between gap-3 text-sm text-muted-foreground tabular-nums">
						<span>
							{formatNumber((page - 1) * PAGE_SIZE + 1)}–{formatNumber(Math.min(page * PAGE_SIZE, total))} of{" "}
							{formatNumber(total)}
						</span>
						<div className="flex gap-1">
							<PageLink href={href({ page: page - 1 })} isDisabled={page <= 1} label="Previous">
								<ChevronLeft />
							</PageLink>
							<PageLink href={href({ page: page + 1 })} isDisabled={page >= pageCount} label="Next">
								<ChevronRight />
							</PageLink>
						</div>
					</div>
				)}
			</div>
		</>
	);
}

function PageLink({ href, isDisabled, label, children }) {
	if (isDisabled) {
		return (
			<Button variant="outline" size="icon" disabled aria-label={label}>
				{children}
			</Button>
		);
	}
	return (
		<Button asChild variant="outline" size="icon">
			<Link href={href} scroll={false} aria-label={label}>
				{children}
			</Link>
		</Button>
	);
}

function gravatarHash(email) {
	return crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

function escapeRegex(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function engagement(contact, statKey, importedKey) {
	if (contact.stats?.[statKey]) return formatNumber(contact.stats[statKey]);
	const rate = contact.imported?.[importedKey];
	return rate === undefined || rate === null ? <TextEmpty /> : `${Math.round(rate * 100)}%`;
}
