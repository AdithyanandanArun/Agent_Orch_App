import { memo, useState, type ComponentProps, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';

function CodeBlock({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const text = typeof children === 'string' ? children : '';
  return (
    <div className="codeblock">
      <button
        type="button" className="codeblock__copy" aria-label="Copy code"
        onClick={() => {
          void navigator.clipboard?.writeText(text.replace(/\n$/, '')).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1400);
          });
        }}
      >
        {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? 'Copied' : 'Copy'}
      </button>
      <pre><code>{children}</code></pre>
    </div>
  );
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
          pre: ({ children }) => <>{children}</>,
          code: ({ className, children, ...rest }: ComponentProps<'code'>) => {
            const isBlock = /language-/.test(className ?? '') || (typeof children === 'string' && children.includes('\n'));
            return isBlock ? <CodeBlock>{children}</CodeBlock> : <code className="md__inline" {...rest}>{children}</code>;
          },
          table: ({ children }) => <div className="md__table"><table>{children}</table></div>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
