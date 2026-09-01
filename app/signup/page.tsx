"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { authClient } from "@/app/components/authClient";

type FieldErrors = { inviteCode?: string; email?: string; password?: string };
type SignUpError = {
  message?: string;
  code?: string;
  status?: number;
  statusText?: string;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// mirrors lib/auth.ts's better-auth config, which leaves minPasswordLength at the library default
// (8) rather than overriding it -- keeping this in sync means the client rejects a too-short
// password before a round trip, not because the two are independently "8" by coincidence.
const MIN_PASSWORD_LENGTH = 8;

function validateInviteCode(value: string): string | undefined {
  if (!value.trim()) return "Enter your invite code.";
  return undefined;
}

function validateEmail(value: string): string | undefined {
  if (!value.trim()) return "Enter your email address.";
  if (!EMAIL_RE.test(value.trim())) return "Enter a valid email address.";
  return undefined;
}

function validatePassword(value: string): string | undefined {
  if (!value) return "Choose a password.";
  if (value.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  return undefined;
}

function describeSignUpError(error: SignUpError): string {
  if (error.message) return error.message;
  if (error.code) return error.code.replaceAll("_", " ").toLowerCase();
  if (error.statusText) return `Signup failed: ${error.statusText}`;
  if (error.status) return `Signup failed with HTTP ${error.status}.`;
  return "Could not create your account. Try again.";
}

export default function SignUpPage() {
  const router = useRouter();

  const [inviteCode, setInviteCode] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const inviteCodeRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setServerError(null);

    const errors: FieldErrors = {
      inviteCode: validateInviteCode(inviteCode),
      email: validateEmail(email),
      password: validatePassword(password),
    };
    setFieldErrors(errors);

    // focus the first invalid field in field order, not object-key order -- matters once more
    // than one field is invalid at once
    if (errors.inviteCode) return inviteCodeRef.current?.focus();
    if (errors.email) return emailRef.current?.focus();
    if (errors.password) return passwordRef.current?.focus();

    setSubmitting(true);
    // better-auth's sign-up body requires `name`; this form deliberately doesn't collect a display
    // name (that's phase 2's settings page), so it seeds one from the email's local part -- never
    // left blank, never a second name field to maintain before settings exists.
    const derivedName = email.trim().split("@")[0] || email.trim();
    // inviteCode is read directly off ctx.body by the invite-redemption hook in lib/auth.ts -- not
    // one of better-auth's named sign-up fields, so the generated signUp.email(...) action's type
    // rejects it as an excess property even though the server's body schema is
    // `.and(z.record(z.string(), z.any()))` and happily accepts it at runtime. $fetch hits the
    // exact same route through the exact same underlying request pipeline (it's what the
    // generated action calls internally) with an untyped body, sidestepping that mismatch.
    const { error } = await authClient.$fetch<{ user: { id: string } }>("/sign-up/email", {
      method: "POST",
      body: {
        name: derivedName,
        email: email.trim(),
        password,
        inviteCode: inviteCode.trim(),
      },
    });
    setSubmitting(false);

    if (error) {
      // server message is already the generic, non-leaking copy from lib/invites.ts
      // (inviteErrorMessage) or better-auth's own account-creation error -- never echoes the
      // invite code or password back
      setServerError(describeSignUpError(error));
      return;
    }

    router.push("/");
  }

  return (
    <main className="na-root">
      <section className="na-section">
        <h1 className="na-heading">Create your account</h1>
        <p className="na-notice">
          This tool is invite-only. You need a code from an existing user to create an account.
        </p>

        <form onSubmit={handleSubmit} noValidate>
          <div className="na-section">
            <div className="na-field">
              <label htmlFor="invite-code">Invite code</label>
              <input
                id="invite-code"
                ref={inviteCodeRef}
                type="text"
                autoComplete="off"
                value={inviteCode}
                onChange={(e) => {
                  setInviteCode(e.target.value);
                  setFieldErrors((prev) => ({ ...prev, inviteCode: undefined }));
                }}
                onBlur={() => setFieldErrors((prev) => ({ ...prev, inviteCode: validateInviteCode(inviteCode) }))}
                disabled={submitting}
                aria-invalid={fieldErrors.inviteCode ? true : undefined}
                aria-describedby={fieldErrors.inviteCode ? "invite-code-error" : undefined}
              />
              {fieldErrors.inviteCode && (
                <p id="invite-code-error" className="na-field-error" role="alert">
                  {fieldErrors.inviteCode}
                </p>
              )}
            </div>

            <div className="na-field">
              <label htmlFor="signup-email">Email</label>
              <input
                id="signup-email"
                ref={emailRef}
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setFieldErrors((prev) => ({ ...prev, email: undefined }));
                }}
                onBlur={() => setFieldErrors((prev) => ({ ...prev, email: validateEmail(email) }))}
                disabled={submitting}
                aria-invalid={fieldErrors.email ? true : undefined}
                aria-describedby={fieldErrors.email ? "signup-email-error" : undefined}
              />
              {fieldErrors.email && (
                <p id="signup-email-error" className="na-field-error" role="alert">
                  {fieldErrors.email}
                </p>
              )}
            </div>

            <div className="na-field">
              <label htmlFor="signup-password">Password</label>
              <input
                id="signup-password"
                ref={passwordRef}
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setFieldErrors((prev) => ({ ...prev, password: undefined }));
                }}
                onBlur={() => setFieldErrors((prev) => ({ ...prev, password: validatePassword(password) }))}
                disabled={submitting}
                aria-invalid={fieldErrors.password ? true : undefined}
                aria-describedby={fieldErrors.password ? "signup-password-error" : undefined}
              />
              {fieldErrors.password && (
                <p id="signup-password-error" className="na-field-error" role="alert">
                  {fieldErrors.password}
                </p>
              )}
            </div>

            {serverError && (
              <p className="na-error" role="alert">
                {serverError}
              </p>
            )}

            <div className="na-actions">
              <button type="submit" className="na-btn na-btn--primary" disabled={submitting}>
                {submitting ? "Creating account…" : "Create account"}
              </button>
              <Link href="/signin" className="na-link-btn">
                Already have an account? Sign in
              </Link>
            </div>
          </div>
        </form>
      </section>
    </main>
  );
}
