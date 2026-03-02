/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from "react";
import { useGameStore } from "./store";
import { supabase } from "./utils/supabase";
import AuthScreen from "./components/AuthScreen";
import JoinScreen from "./components/JoinScreen";
import LobbyScreen from "./components/LobbyScreen";
import RoleRevealScreen from "./components/RoleRevealScreen";
import GameScreen from "./components/GameScreen";
import AssassinScreen from "./components/AssassinScreen";
import GameOverScreen from "./components/GameOverScreen";
import IdleWarningModal from "./components/IdleWarningModal";
import { LanguageToggle } from "./components/LanguageToggle";
import { Loader2 } from "lucide-react";

export default function App() {
  const room = useGameStore((state) => state.room);
  const user = useGameStore((state) => state.user);
  const setAuth = useGameStore((state) => state.setAuth);
  const [isInitializing, setIsInitializing] = useState(true);

  useEffect(() => {
    const initAuth = async () => {
      try {
        const { data: { session }, error: sessionError } = await supabase.auth.getSession();
        if (sessionError) throw sessionError;

        if (session?.user) {
          const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', session.user.id)
            .single();

          if (profileError && profileError.code !== 'PGRST116') {
            console.error("Profile fetch error:", profileError);
          }
          setAuth(session.user, profile);
        } else {
          setAuth(null, null);
        }
      } catch (err) {
        console.error("Auth initialization error:", err);
        setAuth(null, null);
      } finally {
        setIsInitializing(false);
      }
    };

    initAuth();

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_event, session) => {
      try {
        if (session?.user) {
          let { data: profile } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', session.user.id)
            .single();

          // If profile doesn't exist, it might be a new user where the insert hasn't finished.
          // Wait a moment and retry.
          if (!profile) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            const retry = await supabase.from('profiles').select('*').eq('id', session.user.id).single();
            profile = retry.data;
          }

          setAuth(session.user, profile);
        } else {
          setAuth(null, null);
        }
      } catch (err) {
        console.error("Auth state change error:", err);
        setAuth(null, null);
      }
    });

    return () => subscription.unsubscribe();
  }, [setAuth]);

  if (isInitializing) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-indigo-500 animate-spin" />
      </div>
    );
  }

  if (!user) {
    return <AuthScreen />;
  }

  const renderScreen = () => {
    if (!room) {
      return <JoinScreen />;
    }

    switch (room.status) {
      case "lobby":
        return <LobbyScreen />;
      case "role_reveal":
        return <RoleRevealScreen />;
      case "team_building":
      case "team_voting":
      case "team_vote_reveal":
      case "quest_voting":
        return <GameScreen />;
      case "assassin":
        return <AssassinScreen />;
      case "game_over":
        return <GameOverScreen />;
      default:
        return <div>Unknown state</div>;
    }
  };

  return (
    <>
      <LanguageToggle />
      {renderScreen()}
      <IdleWarningModal />
    </>
  );
}
