import React, { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Link } from 'react-router-dom';
import LegalDocumentPage from './LegalDocumentPage';
import {
  buildLegalMarkdownClassMap,
  legalMarkdownParagraphClass,
  remarkChildrenToPlainText,
} from '../utils/legalMarkdownParagraphClass';

const termsUrl = `${process.env.PUBLIC_URL || ''}/docs/terms-of-service.md`;

export default function TermsOfServicePage() {
  const [markdown, setMarkdown] = useState('');
  const [status, setStatus] = useState('loading');
  const classMap = useMemo(() => buildLegalMarkdownClassMap(markdown), [markdown]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(termsUrl);
        if (!res.ok) {
          throw new Error(res.statusText);
        }
        const text = await res.text();
        if (!cancelled) {
          setMarkdown(text);
          setStatus('ready');
        }
      } catch {
        if (!cancelled) {
          setStatus('error');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <LegalDocumentPage title="이용약관">
      {status === 'loading' && <p>불러오는 중입니다…</p>}
      {status === 'error' && (
        <p>
          이용약관 문서를 불러오지 못했습니다.{' '}
          <code>docs/terms-of-service.md</code>가 있는지 확인한 뒤{' '}
          <code>npm start</code> 또는 <code>npm run build</code>를 다시 실행해 주세요.
        </p>
      )}
      {status === 'ready' && (
        <div className="legal-doc__markdown">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: ({ node, children, href, ...props }) => {
                const isInternal = href?.startsWith('/');
                if (isInternal) {
                  return <Link to={href}>{children}</Link>;
                }
                return (
                  <a {...props} href={href} target="_blank" rel="noopener noreferrer">
                    {children}
                  </a>
                );
              },
              p: ({ node, children, className, ...props }) => {
                const startLine = node?.position?.start?.line;
                const mapped = startLine != null ? classMap.get(startLine) : null;
                const variant =
                  mapped || legalMarkdownParagraphClass(remarkChildrenToPlainText(children));
                const merged = [className, variant].filter(Boolean).join(' ');
                return (
                  <p {...props} className={merged || undefined}>
                    {children}
                  </p>
                );
              },
            }}
          >
            {markdown}
          </ReactMarkdown>
        </div>
      )}
    </LegalDocumentPage>
  );
}
