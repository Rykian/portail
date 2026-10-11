import { readFile } from "node:fs/promises";
import { iconPath } from "@/lib/icons";

export async function GET(_request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const file = iconPath(process.env.ICONS_DIR ?? "/data/icons", name);
  if (!file) return new Response("Bad icon name", { status: 400 });

  try {
    const body = new Uint8Array(await readFile(file));
    return new Response(body, {
      headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=86400" },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
