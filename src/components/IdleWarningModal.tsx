import { useGameStore } from "../store";
import { Clock, AlertTriangle } from "lucide-react";
import { useTranslation } from "../utils/i18n";

export default function IdleWarningModal() {
    const idleWarning = useGameStore((state) => state.idleWarning);
    const idleCountdown = useGameStore((state) => state.idleCountdown);
    const pingActivity = useGameStore((state) => state.pingActivity);
    const { t } = useTranslation();

    if (!idleWarning) return null;

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-black/80 backdrop-blur-sm">
            <div className="bg-zinc-950 border border-zinc-800 rounded-3xl p-8 max-w-sm w-full">
                <div className="flex flex-col items-center gap-4">
                    <div className="w-16 h-16 bg-amber-950/50 border border-amber-500/30 rounded-2xl flex items-center justify-center">
                        <AlertTriangle size={32} className="text-amber-400" />
                    </div>
                    <div className="text-center">
                        <h2 className="text-xl font-serif font-bold text-zinc-50 mb-2">
                            {t("Room Inactive")}
                        </h2>
                        <p className="text-zinc-400 text-sm mb-4">
                            {t("This room will close due to inactivity.")}
                        </p>
                        <div className="flex items-center justify-center gap-2 text-amber-400 text-3xl font-mono font-bold">
                            <Clock size={24} />
                            <span>{idleCountdown}s</span>
                        </div>
                    </div>
                    <button
                        onClick={pingActivity}
                        className="w-full mt-2 py-3.5 rounded-xl font-medium bg-emerald-600 hover:bg-emerald-500 text-white transition-colors flex items-center justify-center gap-2"
                    >
                        {t("I'm still here")}
                    </button>
                </div>
            </div>
        </div>
    );
}
