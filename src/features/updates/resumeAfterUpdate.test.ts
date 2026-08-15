import { beforeEach, describe, expect, it } from 'vitest';

import { useDocumentStore } from '@/state/documentStore';
import { useViewerStore } from '@/state/viewerStore';

import { forgetOpenDocument, rememberOpenDocument, takeResumeDocument } from './resumeAfterUpdate';

const KEY = 'folio:resume-after-update';

describe('resumeAfterUpdate', () => {
  beforeEach(() => {
    localStorage.clear();
    useDocumentStore.setState({ sourcePath: null });
    useViewerStore.setState({ currentPage: 1, numPages: 0 });
  });

  it('remembers the open document and the page it was on', () => {
    useDocumentStore.setState({ sourcePath: 'C:\\docs\\statement.pdf' });
    useViewerStore.setState({ currentPage: 7 });

    rememberOpenDocument();

    expect(takeResumeDocument()).toEqual({ path: 'C:\\docs\\statement.pdf', page: 7 });
  });

  it('is consumed once, so the note does not reopen on every later launch', () => {
    useDocumentStore.setState({ sourcePath: '/docs/a.pdf' });
    rememberOpenDocument();

    expect(takeResumeDocument()).not.toBeNull();
    expect(takeResumeDocument()).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('writes nothing for a document with no path on disk', () => {
    // A browser file pick or a deep-link fetch: bytes with no on-disk origin,
    // so there is nothing the relaunched app could reopen.
    useDocumentStore.setState({ sourcePath: null });
    rememberOpenDocument();

    expect(localStorage.getItem(KEY)).toBeNull();
    expect(takeResumeDocument()).toBeNull();
  });

  it('clears a previous note when nothing is open', () => {
    useDocumentStore.setState({ sourcePath: '/docs/a.pdf' });
    rememberOpenDocument();

    // The user closed that document before accepting the restart; restoring the
    // one before last would be worse than restoring none.
    useDocumentStore.setState({ sourcePath: null });
    rememberOpenDocument();

    expect(takeResumeDocument()).toBeNull();
  });

  it('reads a malformed note as no note rather than trusting its shape', () => {
    for (const bad of ['not json', 'null', '{}', '{"path":""}', '{"path":123}', '[]']) {
      localStorage.setItem(KEY, bad);
      expect(takeResumeDocument()).toBeNull();
    }
  });

  it('refuses a stored path that is not an absolute local .pdf', () => {
    // The note is a localStorage entry, so its value is as untrusted as its
    // shape: whatever can write it would otherwise pick the file the next
    // launch reads. A UNC path is refused for the extra reason that reaching
    // it means an outbound SMB connection before the user has done anything.
    for (const bad of [
      '/etc/shadow',
      'C:\\Windows\\System32\\config\\SAM',
      'relative/statement.pdf',
      'statement.pdf',
      '\\\\attacker\\share\\statement.pdf',
      '//attacker/share/statement.pdf',
      'file:///C:/docs/statement.pdf',
      'http://example.com/statement.pdf',
    ]) {
      localStorage.setItem(KEY, JSON.stringify({ path: bad, page: 1 }));
      expect(takeResumeDocument()).toBeNull();
    }
  });

  it('accepts an absolute local .pdf on either platform', () => {
    for (const good of ['/docs/statement.pdf', 'C:\\docs\\statement.PDF', 'D:/docs/a.pdf']) {
      localStorage.setItem(KEY, JSON.stringify({ path: good, page: 2 }));
      expect(takeResumeDocument()).toEqual({ path: good, page: 2 });
    }
  });

  it('writes nothing for a document whose path it would refuse to reopen', () => {
    useDocumentStore.setState({ sourcePath: '\\\\server\\share\\statement.pdf' });
    rememberOpenDocument();

    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('falls back to page 1 when the stored page is missing or nonsense', () => {
    for (const bad of ['{"path":"/a.pdf"}', '{"path":"/a.pdf","page":"3"}']) {
      localStorage.setItem(KEY, bad);
      expect(takeResumeDocument()).toEqual({ path: '/a.pdf', page: 1 });
    }

    localStorage.setItem(KEY, '{"path":"/a.pdf","page":-4}');
    expect(takeResumeDocument()).toEqual({ path: '/a.pdf', page: 1 });
  });

  it('forget drops a pending note', () => {
    useDocumentStore.setState({ sourcePath: '/docs/a.pdf' });
    rememberOpenDocument();
    forgetOpenDocument();

    expect(takeResumeDocument()).toBeNull();
  });
});
