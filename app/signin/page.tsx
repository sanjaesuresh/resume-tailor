"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { authClient } from "@/app/components/authClient";

type FieldErrors = { email?: string; password?: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateEmail(value: string): string | undefined {
  if (!value.trim()) return "Enter your email address.";
  if (!EMAIL_RE.test(value.trim())) return "Enter a valid email address.";
  return undefined;
}

function validatePassword(value: string): string | undefined {
  if (!value) return "Enter your password.";
  return undefined;
}

export default function SignInPage() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setServerError(null);

    const errors: FieldErrors = {
      email: validateEmail(email),
      password: validatePassword(password),
    };
    setFieldErrors(errors);

    if (errors.email) return emailRef.current?.focus();
    if (errors.password) return passwordRef.current?.focus();

    setSubmitting(true);
    const { error } = await authClient.signIn.email({
      email: email.trim(),
      password,
    });
    setSubmitting(false);

    if (error) {
      // deliberately the same generic wording regardless of whether the email or the password was
      // wrong -- distinguishing the two would let a caller probe which emails have accounts
      setServerError(error.message ?? "Couldn't sign you in. Check your email and password.");
      return;
    }

    router.push("/");
  }

  return (
    <main className="na-root">
      <section className="na-section">
        <h1 className="na-heading">Sign in</h1>

        <form onSubmit={handleSubmit} noValidate>
          <div className="na-section">
            <div className="na-field">
              <label htmlFor="signin-email">Email</label>
              <input
                id="signin-email"
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
                aria-describedby={fieldErrors.email ? "signin-email-error" : undefined}
              />
              {fieldErrors.email && (
                <p id="signin-email-error" className="na-field-error" role="alert">
                  {fieldErrors.email}
                </p>
              )}
            </div>

            <div className="na-field">
              <label htmlFor="signin-password">Password</label>
              <input
                id="signin-password"
                ref={passwordRef}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setFieldErrors((prev) => ({ ...prev, password: undefined }));
                }}
                onBlur={() => setFieldErrors((prev) => ({ ...prev, password: validatePassword(password) }))}
                disabled={submitting}
                aria-invalid={fieldErrors.password ? true : undefined}
                aria-describedby={fieldErrors.password ? "signin-password-error" : undefined}
              />
              {fieldErrors.password && (
                <p id="signin-password-error" className="na-field-error" role="alert">
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
                {submitting ? "Signing in…" : "Sign in"}
              </button>
              <Link href="/signup" className="na-link-btn">
                Need an account? Use your invite code
              </Link>
            </div>
          </div>
        </form>
      </section>
    </main>
  );
}
