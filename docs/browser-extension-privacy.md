# Privacy policy: Folio PDF Viewer browser extension

**Last updated: 2 August 2026**

This policy covers the **Folio PDF Viewer** browser extension. The desktop
application is covered by the project's [security policy](../SECURITY.md) and
behaves the same way: nothing is sent anywhere you did not ask it to go.

## The short version

Folio has no servers. There is no Folio account, no telemetry, no analytics, and
no advertising. Nothing you open, type, or annotate is transmitted to the
developer or to any third party. Everything the extension keeps, it keeps on your
own computer.

## What the extension does

When you navigate to a PDF, the extension redirects that page to Folio's own
viewer, which is bundled inside the extension, and the viewer fetches the PDF
from the site hosting it. That request goes to the same server your browser was
already going to, using your existing cookies and session, exactly as the
browser's built-in reader would.

Optionally, you can hand a PDF to the Folio desktop application. That passes the
document's **URL** to the app through the `folio://` link, and the app fetches
the file itself. Only the URL is passed.

## What leaves your device

Nothing, other than the ordinary request for the PDF you chose to open, which
goes to the site that hosts it.

The extension makes no other network requests. It contains no third-party
scripts, no trackers, and no remote code: every asset it uses is bundled in the
package, which is also a Chrome Web Store requirement.

## What is stored on your device

The viewer keeps your work in your browser's local storage, tied to the
extension and readable only by it. Depending on what you use, that can include:

- annotations, highlights, and the text of comments you write, along with the
  nearby document text a comment is anchored to
- text boxes, images, and check marks you place on a page
- results of on-page text recognition, when that feature is available
- signature appearances you draw, type, or upload, and names you have signed
  with, which are remembered so you can reuse them
- interface preferences, such as your theme

This data stays in your browser profile. It is not uploaded, and the developer
cannot see it. Clearing the extension's storage, or removing the extension,
removes it.

## What syncs between your devices

Your **extension settings** (which of the three modes you chose, and the list of
sites you asked Folio to leave alone) are stored using your browser's settings
sync. If you have browser sync turned on, your browser (not Folio) copies them
between your signed-in devices under your own account, subject to your browser
vendor's privacy policy. If sync is off, they stay local.

This is the only data that can leave your device by design, it goes only to your
own browser account, and the site list is the only part of it that says anything
about your browsing.

## Permissions, and why each is needed

| Permission | Why |
| --- | --- |
| Access to all websites (`<all_urls>`) | To recognise and fetch the PDF you navigated to, on whatever site it lives. The extension cannot know in advance which sites host PDFs, so this cannot be narrowed to a list. It is used **only** to fetch PDFs you open; page content is never read, and no content scripts are injected into any page. |
| `declarativeNetRequest` | To redirect a PDF navigation to Folio's viewer. Rules are handed to the browser, which applies them itself; the extension does not see your browsing. |
| `storage` | To remember your settings. |
| `tabs` | To read the current tab's address, so the toolbar button knows whether it is looking at a PDF. |
| `contextMenus` | For the "Open in Folio (desktop)" right-click entry. |

## What Folio never does

- Sell or share your data. There is nobody to share it with.
- Use your data for advertising, profiling, or creditworthiness.
- Send your documents, or anything derived from them, to any server.
- Read or modify the content of pages you visit.

## Artificial intelligence

The browser extension ships no AI features and sends nothing to any AI provider.
The desktop application contains opt-in, bring-your-own-key AI scaffolding that
is off by default; if AI features ever reach the extension, they would send
document text to a provider you chose, and this policy will be updated before
that ships.

## Children

Folio is a document viewer and is not directed at children. It collects no
personal information from anyone, including children.

## Changes

Material changes will be reflected here with a new date, and in the extension's
listing. The history of this file is public in the
[Folio repository](https://github.com/owenpkent/folio).

## Contact

Questions about this policy: **Owenpkent@gmail.com**, or open an issue at
<https://github.com/owenpkent/folio/issues>.
