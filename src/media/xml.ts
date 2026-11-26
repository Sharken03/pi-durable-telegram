/**
 * A forgiving XML tokenizer for Office files: tags and text in document order, no tree. A document that was cut off
 * ends at the last complete token. Never throws.
 */

export type XmlToken =
	| { readonly kind: "open"; readonly name: string; readonly attributes: string; readonly empty: boolean }
	| { readonly kind: "close"; readonly name: string }
	| { readonly kind: "text"; readonly text: string };

const TOKEN =
	/<!\[CDATA\[([\s\S]*?)\]\]>|<[!?][^>]*>|<(\/?)([A-Za-z_][\w.:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)/g;

export function* xmlTokens(xml: string): Generator<XmlToken> {
	const lastOpen = xml.lastIndexOf("<");
	const complete = lastOpen > xml.lastIndexOf(">") ? xml.slice(0, lastOpen) : xml;
	for (const match of complete.matchAll(TOKEN)) {
		const [, cdata, slash, name, rest, text] = match;
		if (cdata !== undefined) yield { kind: "text", text: cdata };
		else if (text !== undefined) yield { kind: "text", text: decodeEntities(text) };
		else if (name === undefined) continue;
		else if (slash === "/") yield { kind: "close", name };
		else {
			const attributes = rest ?? "";
			const empty = attributes.endsWith("/");
			yield { kind: "open", name, attributes: empty ? attributes.slice(0, -1) : attributes, empty };
		}
	}
}

/** The value of attribute `name` in a tag's attribute text, entities decoded. */
export function attribute(attributes: string, name: string): string | undefined {
	const pattern = new RegExp(`(?:^|\\s)${name.replace(/[.]/g, "\\.")}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
	const match = pattern.exec(attributes);
	if (match === null) return undefined;
	return decodeEntities(match[1] ?? match[2] ?? "");
}

const NAMED: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (whole, entity: string) => {
		if (!entity.startsWith("#")) return NAMED[entity] ?? whole;
		const code = entity[1] === "x" ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
		return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
	});
}
