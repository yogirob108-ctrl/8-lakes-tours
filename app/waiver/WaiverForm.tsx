'use client';
import { type FormEvent, useState } from 'react';
import { ADULT_AGE, ageOn } from '@/lib/waiver.mjs';

const labelStyle = { fontSize: '0.65rem', letterSpacing: '0.2em', textTransform: 'uppercase', color: '#c8a96e', display: 'block', marginBottom: '0.45rem' } as const;
const inputStyle = { width: '100%', boxSizing: 'border-box', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(200,169,110,0.3)', borderRadius: '4px', padding: '0.75rem 1rem', color: '#f5f0e8', fontSize: '0.95rem', fontFamily: 'inherit', outline: 'none' } as const;
const signatureStyle = { ...inputStyle, fontFamily: "var(--font-cormorant), 'Cormorant Garamond', serif", fontStyle: 'italic', fontSize: '1.1rem' } as const;
const groupStyle = { marginTop: '1.2rem' } as const;

export default function WaiverForm({ initialReference }: { initialReference: string }) {
  const [reference, setReference] = useState(initialReference.toUpperCase());
  const [riderName, setRiderName] = useState('');
  const [riderEmail, setRiderEmail] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [guardianName, setGuardianName] = useState('');
  const [guardianRelationship, setGuardianRelationship] = useState('');
  const [signature, setSignature] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [status, setStatus] = useState<'idle' | 'sending' | 'done'>('idle');
  const [error, setError] = useState('');

  const today = new Date().toISOString().slice(0, 10);
  const age = dateOfBirth ? ageOn(dateOfBirth, today) : null;
  const isMinor = age !== null && age < ADULT_AGE;
  const signer = isMinor ? 'parent or guardian' : 'rider';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setStatus('sending');
    const honeypot = (event.currentTarget.elements.namedItem('website') as HTMLInputElement | null)?.value || '';
    try {
      const response = await fetch('/api/waiver', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reference,
          rider_name: riderName,
          rider_email: riderEmail,
          date_of_birth: dateOfBirth,
          guardian_name: isMinor ? guardianName : '',
          guardian_relationship: isMinor ? guardianRelationship : '',
          signature,
          agreed: agreed ? 'on' : '',
          website: honeypot,
        }),
      });
      const result = await response.json().catch(() => ({ ok: false, error: 'Something went wrong. Please try again.' }));
      if (!response.ok || !result.ok) {
        setError(result.error || 'Something went wrong. Please try again.');
        setStatus('idle');
        return;
      }
      setStatus('done');
    } catch {
      setError('We could not reach the server. Please check your connection and try again.');
      setStatus('idle');
    }
  }

  if (status === 'done') {
    return (
      <div role="status" style={{ marginTop: '2rem', padding: '1.4rem', border: '1px solid rgba(200,169,110,0.35)', borderRadius: '4px', background: 'rgba(200,169,110,0.06)' }}>
        <p style={{ margin: 0, fontSize: '1rem', color: '#f5f0e8' }}>Your waiver submission has been received.</p>
        <p style={{ margin: '0.6rem 0 0', fontSize: '0.9rem', lineHeight: 1.7 }}>We will review it before departure. If anyone else in your group still needs to submit a waiver, send them this page.</p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} style={{ marginTop: '2rem' }} noValidate>
      <div style={groupStyle}>
        <label htmlFor="reference" style={labelStyle}>Booking reference</label>
        <input id="reference" style={inputStyle} value={reference} onChange={e => setReference(e.target.value.toUpperCase())} placeholder="8L-ABC123" autoComplete="off" required maxLength={24} />
      </div>
      <div style={groupStyle}>
        <label htmlFor="rider_name" style={labelStyle}>Rider&apos;s full legal name</label>
        <input id="rider_name" style={inputStyle} value={riderName} onChange={e => setRiderName(e.target.value)} placeholder="As shown on their passport" autoComplete="name" required maxLength={150} />
      </div>
      <div style={groupStyle}>
        <label htmlFor="date_of_birth" style={labelStyle}>Rider&apos;s date of birth</label>
        <input id="date_of_birth" type="date" style={inputStyle} value={dateOfBirth} onChange={e => setDateOfBirth(e.target.value)} max={today} min="1900-01-01" required />
      </div>
      <div style={groupStyle}>
        <label htmlFor="rider_email" style={labelStyle}>Email for your signed copy</label>
        <input id="rider_email" type="email" style={inputStyle} value={riderEmail} onChange={e => setRiderEmail(e.target.value)} autoComplete="email" required maxLength={254} />
      </div>

      {isMinor && (
        <div style={{ marginTop: '1.6rem', padding: '1rem 1.2rem', border: '1px solid rgba(200,169,110,0.25)', borderRadius: '4px' }}>
          <p style={{ margin: 0, fontSize: '0.88rem', lineHeight: 1.7 }}>This rider is under 18, so a parent or legal guardian must sign for them.</p>
          <div style={groupStyle}>
            <label htmlFor="guardian_name" style={labelStyle}>Parent or guardian&apos;s full legal name</label>
            <input id="guardian_name" style={inputStyle} value={guardianName} onChange={e => setGuardianName(e.target.value)} required maxLength={150} />
          </div>
          <div style={groupStyle}>
            <label htmlFor="guardian_relationship" style={labelStyle}>Relationship to the rider</label>
            <input id="guardian_relationship" style={inputStyle} value={guardianRelationship} onChange={e => setGuardianRelationship(e.target.value)} placeholder="Mother, father, legal guardian" required maxLength={60} />
          </div>
        </div>
      )}

      <div style={{ marginTop: '1.6rem' }}>
        <label htmlFor="signature" style={labelStyle}>Signature: type the {signer}&apos;s full name</label>
        <input id="signature" style={signatureStyle} value={signature} onChange={e => setSignature(e.target.value)} placeholder={isMinor ? 'Parent or guardian full name' : 'Your full name'} required maxLength={150} />
      </div>
      <input type="text" name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" style={{ position: 'absolute', left: '-9999px', width: 1, height: 1 }} />
      <label style={{ display: 'flex', gap: '0.7rem', alignItems: 'flex-start', marginTop: '1.2rem', fontSize: '0.85rem', lineHeight: 1.6, cursor: 'pointer' }}>
        <input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)} style={{ marginTop: '0.25rem', accentColor: '#c8a96e' }} />
        <span>{isMinor
          ? 'I am the parent or legal guardian of this rider. I have read the waiver above and agree to it on their behalf and for myself.'
          : 'I have read the waiver above and agree to it. I confirm I am 18 or older.'}</span>
      </label>

      {error && <p role="alert" style={{ marginTop: '1rem', color: '#e8a48f', fontSize: '0.88rem', lineHeight: 1.6 }}>{error}</p>}

      <button type="submit" disabled={status === 'sending'} style={{ marginTop: '1.6rem', width: '100%', padding: '1rem', background: '#c8a96e', color: '#0e0c09', border: 'none', borderRadius: '4px', fontSize: '0.75rem', letterSpacing: '0.25em', textTransform: 'uppercase', fontWeight: 500, cursor: status === 'sending' ? 'wait' : 'pointer', opacity: status === 'sending' ? 0.7 : 1 }}>
        {status === 'sending' ? 'Signing…' : 'Sign the waiver'}
      </button>
      <p style={{ marginTop: '1rem', fontSize: '0.78rem', opacity: 0.6, lineHeight: 1.6 }}>Questions? Email info@8lakestours.com before signing.</p>
    </form>
  );
}
