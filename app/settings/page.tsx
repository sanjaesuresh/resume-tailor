"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { safeJson, isValidSettings, useMountedRef, type Settings } from "@/app/components/settingsHelpers";
import SettingsResumeSection from "@/app/components/SettingsResumeSection";
import SettingsWhitelistSection from "@/app/components/SettingsWhitelistSection";
import SettingsPromptSection from "@/app/components/SettingsPromptSection";
import SettingsDisplayNameSection from "@/app/components/SettingsDisplayNameSection";
import type { WhitelistBreadth } from "@/lib/prompts/whitelist";

export default function SettingsPage() {
  const router = useRouter();
  const mounted = useMountedRef();

  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // the skills whitelist textarea is written to from two places -- its own "Generate" button and
  // the base resume section's post-save offer -- so its live edit buffer lives here rather than
  // inside SettingsWhitelistSection. settings.skillsWhitelist stays the last-*saved* value; this
  // is what's currently in the textarea, saved or not.
  const [whitelistValue, setWhitelistValue] = useState("");
  const whitelistSeeded = useRef(false);

  const [generatingWhitelist, setGeneratingWhitelist] = useState(false);
  const [generateWhitelistError, setGenerateWhitelistError] = useState<string | null>(null);

  // a session that's expired since the page loaded (GET, any of the four saves, or the whitelist
  // generator can all discover this) sends the user to sign back in rather than leaving them on
  // a settings page that silently stops saving
  const goToSignIn = useCallback(() => router.push("/signin"), [router]);

  const loadSettings = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch("/api/settings");
      if (res.status === 401) {
        goToSignIn();
        return;
      }
      const data = await safeJson(res);
      if (!mounted.current) return;
      if (res.ok && isValidSettings(data?.settings)) {
        setSettings(data.settings);
      } else {
        const message =
          typeof data?.error === "string" ? data.error : `Failed to load settings (${res.status}).`;
        setLoadError(message);
      }
    } catch {
      if (!mounted.current) return;
      setLoadError("Network error while loading your settings.");
    }
  }, [goToSignIn, mounted]);

  useEffect(() => {
    // fetch-on-mount to hydrate this client page -- same external-system-sync justification as
    // app/page.tsx's loadApplications effect
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    // seed the whitelist buffer exactly once, on first load -- never again, so a later settings
    // update (from saving a *different* field) can't clobber whatever the user has typed here
    if (settings && !whitelistSeeded.current) {
      setWhitelistValue(settings.skillsWhitelist ?? "");
      whitelistSeeded.current = true;
    }
  }, [settings]);

  // breadth defaults to the narrowest width. Widening this is widening what the tailoring
  // pipeline is allowed to write into a resume, so it is a thing the user reaches for, never a
  // thing they arrive at.
  async function handleGenerateWhitelist(breadth: WhitelistBreadth = 1) {
    setGeneratingWhitelist(true);
    setGenerateWhitelistError(null);
    try {
      const res = await fetch("/api/settings/whitelist/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ breadth }),
      });
      if (res.status === 401) {
        goToSignIn();
        return;
      }
      const data = await safeJson(res);
      if (!mounted.current) return;
      if (res.ok && typeof data?.whitelist === "string") {
        // a draft only -- the user still has to review and hit Save in the whitelist section
        setWhitelistValue(data.whitelist);
      } else {
        const message =
          typeof data?.error === "string" ? data.error : "Couldn't generate a whitelist draft.";
        setGenerateWhitelistError(message);
      }
    } catch {
      if (!mounted.current) return;
      setGenerateWhitelistError("Network error while generating the whitelist draft.");
    } finally {
      if (mounted.current) setGeneratingWhitelist(false);
    }
  }

  return (
    <main className="na-root">
      <h1 className="na-heading">Settings</h1>

      {loadError && (
        <div role="alert" className="tr-error">
          <span>{loadError}</span>
          <button type="button" onClick={loadSettings} className="tr-retry-btn">
            Retry
          </button>
        </div>
      )}

      {settings === null && !loadError && (
        <div className="tr-skeleton" role="status" aria-label="Loading settings">
          <div className="tr-skeleton-row" aria-hidden="true" />
          <div className="tr-skeleton-row" aria-hidden="true" />
          <div className="tr-skeleton-row" aria-hidden="true" />
          <div className="tr-skeleton-row" aria-hidden="true" />
        </div>
      )}

      {settings && (
        <div className="na-section">
          <SettingsResumeSection
            resumeTex={settings.resumeTex}
            onSaved={setSettings}
            onUnauthorized={goToSignIn}
            generatingWhitelist={generatingWhitelist}
            generateWhitelistError={generateWhitelistError}
            onGenerateWhitelist={handleGenerateWhitelist}
          />

          <SettingsWhitelistSection
            value={whitelistValue}
            onChange={setWhitelistValue}
            savedValue={settings.skillsWhitelist ?? ""}
            onSaved={setSettings}
            onUnauthorized={goToSignIn}
            generating={generatingWhitelist}
            generateError={generateWhitelistError}
            onGenerate={handleGenerateWhitelist}
          />

          <SettingsPromptSection
            prompt={settings.tailorPrompt}
            isDefault={settings.isPromptDefault}
            onSaved={setSettings}
            onUnauthorized={goToSignIn}
          />

          <SettingsDisplayNameSection
            name={settings.displayName}
            onSaved={setSettings}
            onUnauthorized={goToSignIn}
          />
        </div>
      )}
    </main>
  );
}
