"use server";

import { isValidObjectId } from "@/lib/d1-id";
import { revalidatePath } from "next/cache";
import { notifyActivity } from "@/lib/alerts";
import { generateApiKey } from "@/lib/api-keys";
import { requireSession } from "@/lib/auth";
import { getAppUrl } from "@/lib/config";
import { connectDb } from "@/lib/db";
import ApiKey from "@/models/ApiKey";

export async function createApiKey(_state, formData) {
	await requireSession();
	const name = String(formData.get("name") ?? "")
		.trim()
		.slice(0, 60);
	if (!name) return { error: "Name is required" };

	await connectDb();
	const { key, prefix, hash } = generateApiKey();
	await ApiKey.create({ name, prefix, hash });
	await notifyActivity([`API key created: ${name}`, `${getAppUrl()}/api-keys`]);

	revalidatePath("/api-keys");
	return { key };
}

export async function revokeApiKey(id) {
	await requireSession();
	if (!isValidObjectId(id)) return { error: "Key not found" };

	await connectDb();
	await ApiKey.updateOne({ _id: id, revokedAt: null }, { $set: { revokedAt: new Date() } });

	revalidatePath("/api-keys");
	return { ok: true };
}
