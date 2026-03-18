import { useState, useEffect } from 'react';
import { supabase } from './supabaseClient';
import Login from './Login';
import App from './App';

export default function AppWrapper() {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, []);

  if (loading) {
    return (
      <div style={{
        fontFamily: "'DM Sans', sans-serif",
        background: '#0d1117',
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#8b949e',
        fontSize: 16,
      }}>
        Loading...
      </div>
    );
  }

  if (!session) {
    return <Login onLogin={(s) => setSession(s)} />;
  }

  return <App session={session} />;
}
