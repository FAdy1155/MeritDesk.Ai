// The disclosure an owner/admin acknowledges before turning on the
// connector's case-work tools (src/lib/connector/settings.ts). Client-safe:
// the Firm page renders it and the service checks the version.
//
// The version is stored with the acknowledgment
// (tenant_connector_settings.disclosure_version). Change the text in a way
// that matters to a firm and you must change the version too: the case-work
// tools then stop for every firm until an owner/admin acknowledges the new
// text, because they agreed to the old one.

export const CONNECTOR_DISCLOSURE_VERSION = "2026-11-02.1";

export const CONNECTOR_DISCLOSURE_TITLE = "Before you connect case work to Claude or ChatGPT";

export const CONNECTOR_DISCLOSURE_PARAGRAPHS: readonly string[] = [
  "With case work turned on, any member of the firm who connects this app to Claude (Anthropic) or ChatGPT (OpenAI) can have those assistants read the firm's matters, client names on matters, document lists, skill run reports and legal updates. Members with an editor role can also create client and matter records, link clients to matters and queue skill runs. Information supplied as tool input or returned by a tool is part of that member's conversation with the assistant. Case work works only through the Claude and ChatGPT clients this platform recognizes; a connection from any other app gets the library tools only.",
  "Client records created through the connector may include the full name, A-number, date of birth, country of birth, language and contact details supplied by the member; those values are sent to the AI provider as tool input. Skill run reports go to the conversation with A-numbers and dates of birth replaced by a redaction marker, but they still contain client names, the facts of the case, places and other dates (and a date of birth written into a sentence may remain). Matter lists contain client names. Treat every case-work result and tool input as confidential client information.",
  "Once client information is in a Claude or ChatGPT conversation, it is governed by Anthropic's or OpenAI's terms, privacy policy and data retention for that member's account, not by this app's. This app cannot see, export or delete those conversations, and turning case work off later does not remove what was already shared.",
  "Depending on the plan and the account's settings, a provider may keep conversations and may use them to improve its models. We recommend that every member who connects uses a business or enterprise plan whose current terms say conversations are not used for training (for example Claude Team or Enterprise, or ChatGPT Business or Enterprise), and that the firm confirms those terms and settings itself before connecting.",
  "Your professional duties of confidentiality still apply. Decide which matters may be discussed with an AI provider, and whether a client's consent is needed, before members connect.",
  "Every case-work tool call is recorded in the firm's audit log with the member, the tool and the matter. Document files are never sent through the connector; a short-lived download link for a document that passed the malware scan is offered only if the firm also turns that on below, only to owner/admins, attorneys and paralegals, and only after the member confirms each link.",
];
