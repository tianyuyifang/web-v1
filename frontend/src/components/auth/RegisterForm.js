"use client";

import { useState } from "react";
import Link from "next/link";
import { authAPI } from "@/lib/api";
import { useLanguage } from "@/components/layout/LanguageProvider";

function validate(form) {
  const errors = {};
  if (!form.username) {
    errors.username = "usernameRequired";
  } else if (form.username.length < 2) {
    errors.username = "usernameMin";
  } else if (form.username.length > 30) {
    errors.username = "usernameMax";
  } else if (!/^[\u4e00-\u9fffa-zA-Z0-9_]+$/.test(form.username)) {
    errors.username = "usernameChars";
  }

  if (!form.password) {
    errors.password = "passwordRequired";
  } else if (form.password.length < 8) {
    errors.password = "passwordMin";
  }

  if (!form.confirm) {
    errors.confirm = "confirmRequired";
  } else if (form.password && form.confirm !== form.password) {
    errors.confirm = "passwordsMismatch";
  }

  return errors;
}

export default function RegisterForm() {
  const { t } = useLanguage();
  const [form, setForm] = useState({ username: "", password: "", confirm: "" });
  const [fieldErrors, setFieldErrors] = useState({});
  const [serverError, setServerError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [touched, setTouched] = useState({});
  const [registered, setRegistered] = useState(false);

  const update = (field) => (e) => {
    const newForm = { ...form, [field]: e.target.value };
    setForm(newForm);
    if (touched[field]) {
      const errors = validate(newForm);
      setFieldErrors((prev) => ({ ...prev, [field]: errors[field] }));
    }
  };

  const handleBlur = (field) => () => {
    setTouched((prev) => ({ ...prev, [field]: true }));
    const errors = validate(form);
    setFieldErrors((prev) => ({ ...prev, [field]: errors[field] }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setTouched({ username: true, password: true, confirm: true });
    const errors = validate(form);
    setFieldErrors(errors);

    if (Object.keys(errors).length > 0) return;

    setSubmitting(true);
    setServerError("");

    try {
      await authAPI.register({ username: form.username, password: form.password });
      setRegistered(true);
    } catch (err) {
      setServerError(
        err.response?.data?.error?.message ||
          err.response?.data?.message ||
          t("registrationFailed"),
      );
    } finally {
      setSubmitting(false);
    }
  };

  const inputClass = (field) =>
    `w-full rounded-lg border px-3.5 py-2.5 text-sm focus:outline-none ${
      fieldErrors[field]
        ? "border-red-500 focus:border-red-500"
        : "border-border bg-background focus:border-primary"
    }`;

  if (registered) {
    return (
      <div className="space-y-4 text-center">
        <div className="rounded-xl border border-green-500/20 bg-green-500/10 px-6 py-8">
          <div className="mx-auto mb-3 inline-flex h-10 w-10 items-center justify-center rounded-full bg-green-500/20 text-lg">
            ✓
          </div>
          <p className="text-base font-semibold" style={{ color: "var(--text)" }}>{t("accountCreated")}</p>
          <p className="mt-2 text-sm text-muted">
            {t("awaitingApproval")}
          </p>
        </div>
        <p className="text-sm text-muted">
          {t("alreadyApproved")}{" "}
          <Link href="/login" className="font-medium text-primary hover:underline">
            {t("signIn")}
          </Link>
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div>
        <label htmlFor="reg-username" className="mb-1.5 block text-sm font-medium text-muted">
          {t("username")}
        </label>
        <input
          id="reg-username"
          type="text"
          value={form.username}
          onChange={update("username")}
          onBlur={handleBlur("username")}
          placeholder={t("usernamePlaceholder")}
          className={inputClass("username")}
          style={{ color: "var(--text)" }}
          autoComplete="username"
        />
        {fieldErrors.username && (
          <p className="mt-1 text-xs text-red-400">{t(fieldErrors.username)}</p>
        )}
      </div>

      <div>
        <label htmlFor="reg-password" className="mb-1.5 block text-sm font-medium text-muted">
          {t("password")}
        </label>
        <input
          id="reg-password"
          type="password"
          value={form.password}
          onChange={update("password")}
          onBlur={handleBlur("password")}
          placeholder={t("passwordPlaceholder")}
          className={inputClass("password")}
          style={{ color: "var(--text)" }}
          autoComplete="new-password"
        />
        {fieldErrors.password && (
          <p className="mt-1 text-xs text-red-400">{t(fieldErrors.password)}</p>
        )}
      </div>

      <div>
        <label htmlFor="reg-confirm" className="mb-1.5 block text-sm font-medium text-muted">
          {t("confirmPassword")}
        </label>
        <input
          id="reg-confirm"
          type="password"
          value={form.confirm}
          onChange={update("confirm")}
          onBlur={handleBlur("confirm")}
          placeholder={t("confirmPlaceholder")}
          className={inputClass("confirm")}
          style={{ color: "var(--text)" }}
          autoComplete="new-password"
        />
        {fieldErrors.confirm && (
          <p className="mt-1 text-xs text-red-400">{t(fieldErrors.confirm)}</p>
        )}
      </div>

      {serverError && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3.5 py-2.5 text-sm text-red-400" role="alert">
          {serverError}
        </div>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? t("creatingAccount") : t("createAccount")}
      </button>

      <p className="text-center text-sm text-muted">
        {t("alreadyHaveAccount")}{" "}
        <Link href="/login" className="font-medium text-primary hover:underline">
          {t("signIn")}
        </Link>
      </p>
    </form>
  );
}
