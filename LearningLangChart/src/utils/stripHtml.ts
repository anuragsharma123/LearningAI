export function stripHtml(html: string, maxChars = 3000): string {
    return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, maxChars);
}
