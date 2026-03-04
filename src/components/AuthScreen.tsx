import React, { useState } from 'react';
import { useGameStore } from '../store';
import { supabase } from '../utils/supabase';
import { Shield, Loader2, WifiOff } from 'lucide-react';
import { cn } from '../utils/cn';

export default function AuthScreen() {
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [betaCode, setBetaCode] = useState('');
  const [devClickCount, setDevClickCount] = useState(0);
  const setAuth = useGameStore((state) => state.setAuth);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      // Add a timeout to detect network issues (e.g., GFW blocking Supabase)
      const timeout = (ms: number) => new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Network timeout: Supabase might be blocked by your network. Please check your connection or use a VPN.')), ms)
      );

      if (isLogin) {
        const loginPromise = supabase.auth.signInWithPassword({ email, password });
        const { data, error } = await Promise.race([loginPromise, timeout(15000)]) as any;

        if (error) throw error;

        // Fetch profile
        const { data: profile } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', data.user.id)
          .single();

        setAuth(data.user, profile);
      } else {
        if (!username.trim()) throw new Error('Username is required');
        if (betaCode.trim().toLowerCase() !== 'dagong') throw new Error('内测码不正确 / Invalid beta code');

        const signUpPromise = supabase.auth.signUp({ email, password });
        const { data, error } = await Promise.race([signUpPromise, timeout(15000)]) as any;

        if (error) throw error;

        if (data?.user) {
          // If session is null, Supabase requires email confirmation
          if (!data.session) {
            setError('Account created! Please check your email to verify your account. (Admin: You can disable "Confirm email" in Supabase Auth settings)');
            setLoading(false);
            return;
          }

          // Create profile
          const { error: profileError } = await supabase
            .from('profiles')
            .insert([{ id: data.user.id, username: username.trim() }]);

          if (profileError) {
            console.error("Profile creation error:", profileError);
            // Don't throw here, let them log in even if profile fails, so they aren't stuck
          }

          setAuth(data.user, { id: data.user.id, username: username.trim(), wins: 0, losses: 0, total_games: 0 });
        }
      }
    } catch (err: any) {
      console.error("Auth error:", err);
      setError(err.message || 'An unexpected error occurred');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6 text-zinc-50 relative overflow-hidden">
      {/* Epic Background Image */}
      <div
        className="absolute inset-0 bg-cover bg-center bg-no-repeat"
        style={{ backgroundImage: 'url(/avalon-bg.jpg)' }}
      />
      {/* Dark overlay for readability */}
      <div className="absolute inset-0 bg-gradient-to-b from-zinc-950/70 via-zinc-950/80 to-zinc-950/95" />

      <div className="w-full max-w-sm space-y-8 relative z-10">
        <div className="text-center">
          <button
            type="button"
            className="w-28 h-28 rounded-3xl overflow-hidden mx-auto mb-6 shadow-[0_0_40px_rgba(99,102,241,0.3)]"
            onClick={() => setDevClickCount(prev => prev + 1)}
          >
            <img src="/avalon-logo.png" alt="Avalon Online" className="w-full h-full object-cover" />
          </button>
          <h1 className="text-3xl font-serif font-bold tracking-tight">Avalon Online</h1>
          <p className="text-zinc-400 mt-2 text-sm">A Game of Hidden Loyalty</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="p-3 bg-red-950/50 border border-red-500/50 text-red-400 rounded-xl text-sm text-center">
              {error}
            </div>
          )}

          {!isLogin && (
            <>
              <div>
                <label className="block text-xs font-medium text-zinc-500 uppercase tracking-wider mb-1.5">Username</label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 transition-all"
                  placeholder="Merlin123"
                  required={!isLogin}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-500 uppercase tracking-wider mb-1.5">内测码 / Beta Code</label>
                <input
                  type="text"
                  value={betaCode}
                  onChange={(e) => setBetaCode(e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 transition-all"
                  placeholder="Enter beta code"
                  required={!isLogin}
                />
              </div>
            </>
          )}

          <div>
            <label className="block text-xs font-medium text-zinc-500 uppercase tracking-wider mb-1.5">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 transition-all"
              placeholder="player@example.com"
              required
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-zinc-500 uppercase tracking-wider mb-1.5">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 transition-all"
              placeholder="••••••••"
              required
              minLength={6}
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl py-3.5 font-medium transition-colors flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed mt-6"
          >
            {loading ? <Loader2 className="animate-spin" size={20} /> : (isLogin ? 'Sign In' : 'Create Account')}
          </button>

          {import.meta.env.DEV && devClickCount >= 5 && (
            <div className="animate-in fade-in slide-in-from-top-4 duration-300">
              <div className="relative flex items-center py-4">
                <div className="flex-grow border-t border-zinc-800"></div>
                <span className="flex-shrink-0 mx-4 text-zinc-500 text-xs">DEVELOPER MODE</span>
                <div className="flex-grow border-t border-zinc-800"></div>
              </div>

              <div className="mb-4">
                <label className="block text-xs font-medium text-zinc-500 uppercase tracking-wider mb-1.5">Force Identify (Host Only)</label>
                <select
                  onChange={(e) => useGameStore.getState().setDevRequestedRole(e.target.value as any || undefined)}
                  className="w-full bg-zinc-900 border border-zinc-700/50 rounded-xl px-4 py-3 text-sm text-zinc-300 focus:outline-none focus:ring-1 focus:ring-indigo-500/50 appearance-none"
                >
                  <option value="">Random (Default)</option>
                  <option value="Merlin">Merlin</option>
                  <option value="Assassin">Assassin</option>
                  <option value="Percival">Percival</option>
                  <option value="Morgana">Morgana</option>
                  <option value="Oberon">Oberon</option>
                  <option value="Mordred">Mordred</option>
                  <option value="Loyal Servant">Loyal Servant</option>
                  <option value="Minion">Minion</option>
                </select>
              </div>

              <button
                type="button"
                onClick={() => {
                  const mockUserId = `offline_${Math.random().toString(36).substring(2, 9)}`;
                  const mockUsername = username.trim() || `Player_${Math.floor(Math.random() * 1000)}`;
                  setAuth(
                    { id: mockUserId } as any,
                    { id: mockUserId, username: mockUsername, wins: 0, losses: 0, total_games: 0 }
                  );
                }}
                className="w-full bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700 rounded-xl py-3.5 font-medium transition-colors flex items-center justify-center gap-2"
              >
                <WifiOff size={18} />
                Play Offline Bypassing Login
              </button>
            </div>
          )}
        </form>

        <div className="text-center">
          <button
            type="button"
            onClick={() => {
              setIsLogin(!isLogin);
              setError(null);
            }}
            className="text-sm text-zinc-400 hover:text-zinc-300 transition-colors"
          >
            {isLogin ? "Don't have an account? Sign up" : "Already have an account? Sign in"}
          </button>
        </div>

        <p className="text-center text-zinc-600 text-xs mt-6">v{__APP_VERSION__}</p>
      </div>
    </div>
  );
}
