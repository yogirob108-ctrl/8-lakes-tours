'use client';

import { useState } from 'react';

export type FaqItem = readonly [question: string, answer: string];

export default function FaqAccordion({ items }: { items: readonly FaqItem[] }) {
  const [openItems, setOpenItems] = useState<Set<string>>(new Set());

  const toggleItem = (question: string) => {
    setOpenItems(current => {
      const next = new Set(current);
      if (next.has(question)) next.delete(question);
      else next.add(question);
      return next;
    });
  };

  return (
    <div className="faq-accordion">
      {items.map(([question, answer]) => {
        const isOpen = openItems.has(question);
        const panelId = `faq-panel-${question.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}`;
        return (
          <div key={question} className={`faq-item ${isOpen ? 'open' : ''}`}>
            <h3 className="faq-heading">
            <button
              type="button"
              className="faq-question"
              aria-expanded={isOpen}
              aria-controls={panelId}
              onClick={() => toggleItem(question)}
            >
              <span>{question}</span>
              <span className="faq-icon" aria-hidden="true">+</span>
            </button>
            </h3>
            <div id={panelId} className="faq-panel">
              <div className="faq-panel-inner">
                <p>{answer}</p>
              </div>
            </div>
          </div>
        );
      })}
      <style jsx>{`
        .faq-accordion {
          margin-top: 1.5rem;
          border-bottom: 1px solid rgba(200,169,110,0.15);
        }
        .faq-item {
          border-top: 1px solid rgba(200,169,110,0.15);
        }
        .faq-heading {
          margin: 0;
          font: inherit;
        }
        .faq-question {
          width: 100%;
          border: 0;
          background: transparent;
          color: #f5f0e8;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 1rem;
          padding: 1.35rem 0;
          text-align: left;
          font-family: var(--font-cormorant), 'Cormorant Garamond', serif;
          font-size: 1.35rem;
          font-weight: 400;
          line-height: 1.2;
        }
        .faq-question:focus-visible {
          outline: 2px solid #c8a96e;
          outline-offset: 4px;
        }
        .faq-icon {
          flex: 0 0 auto;
          color: #c8a96e;
          font-family: var(--font-jost), 'Jost', sans-serif;
          font-size: 1.1rem;
          line-height: 1;
          transition: transform 0.26s ease;
        }
        .faq-item.open .faq-icon {
          transform: rotate(45deg);
        }
        .faq-panel {
          display: grid;
          grid-template-rows: 0fr;
          transition: grid-template-rows 0.34s ease;
        }
        .faq-item.open .faq-panel {
          grid-template-rows: 1fr;
        }
        .faq-panel-inner {
          min-height: 0;
          overflow: hidden;
        }
        .faq-panel p {
          margin: 0;
          padding: 0 0 1.6rem;
          font-size: 0.95rem;
          line-height: 1.85;
          color: #d4cfc4;
          opacity: 0;
          transform: translateY(-4px);
          transition: opacity 0.24s ease, transform 0.24s ease;
        }
        .faq-item.open .faq-panel p {
          opacity: 0.86;
          transform: translateY(0);
        }
        @media (prefers-reduced-motion: reduce) {
          .faq-panel,
          .faq-panel p,
          .faq-icon {
            transition: none;
          }
        }
      `}</style>
    </div>
  );
}
