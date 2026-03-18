import { useState } from 'react';
import { supabase } from './supabaseClient';

export default function Login({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSignUp, setIsSignUp] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);

  const handleSubmit = async () => {
    if (!email || !password) return;
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      if (isSignUp) {
        const { data, error: err } = await supabase.auth.signUp({ email, password });
        if (err) throw err;
        if (data.user && !data.session) {
          setMessage('Check your email to confirm your account, then log in.');
        } else if (data.session) {
          onLogin(data.session);
        }
      } else {
        const { data, error: err } = await supabase.auth.signInWithPassword({ email, password });
        if (err) throw err;
        onLogin(data.session);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ fontFamily: "'DM Sans', sans-serif", background: '#0d1117', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#e8eaf0' }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&display=swap');`}</style>
      <div style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 12, padding: 40, width: 400, maxWidth: '90vw' }}>
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{ fontSize: 28, fontWeight: 700, background: 'linear-gradient(135deg, #58a6ff 0%, #3fb950 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', marginBottom: 6 }}>Wyckomar</div>
          <div style={{ fontSize: 14, color: '#8b949e' }}>Global BOM Manager</div>
        </div>
        {error && <div style={{ background: 'rgba(218,54,51,0.12)', border: '1px solid rgba(218,54,51,0.3)', color: '#f85149', borderRadius: 8, padding: '10px 14px', fontSize: 13, marginBottom: 16 }}>{error}</div>}
        {message && <div style={{ background: 'rgba(46,160,67,0.12)', border: '1px solid rgba(46,160,67,0.3)', color: '#3fb950', borderRadius: 8, padding: '10px 14px', fontSize: 13, marginBottom: 16 }}>{message}</div>}
        <div style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', fontSize: 13, color: '#8b949e', marginBottom: 6 }}>Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" style={{ width: '100%', padding: '10px 12px', background: '#0d1117', border: '1px solid #30363d', borderRadius: 6, color: '#e8eaf0', fontSize: 14, fontFamily: 'inherit' }} />
        </div>
        <div style={{ marginBottom: 24 }}>
          <label style={{ display: 'block', fontSize: 13, color: '#8b949e', marginBottom: 6 }}>Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="********" onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); }} style={{ width: '100%', padding: '10px 12px', background: '#0d1117', border: '1px solid #30363d', borderRadius: 6, color: '#e8eaf0', fontSize: 14, fontFamily: 'inherit' }} />
        </div>
        <button onClick={handleSubmit} disabled={loading || !email || !password} style={{ width: '100%', padding: '11px 14px', background: loading ? '#30363d' : '#238636', color: 'white', border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 600, fontFamily: 'inherit', cursor: loading ? 'wait' : 'pointer', marginBottom: 16 }}>
          {loading ? 'Please wait...' : isSignUp ? 'Create Account' : 'Sign In'}
        </button>
        <div style={{ textAlign: 'center', fontSize: 13, color: '#8b949e' }}>
          {isSignUp ? 'Already have an account?' : "Don't have an account?"}{' '}
          <span onClick={() => { setIsSignUp(!isSignUp); setError(null); setMessage(null); }} style={{ color: '#58a6ff', cursor: 'pointer' }}>
            {isSignUp ? 'Sign in' : 'Sign up'}
          </span>
        </div>
      </div>
    </div>
  );
}
