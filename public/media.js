/* KagNode Media: interaction only. Permissions and publication are server-side. */
(() => {
  const $ = (selector) => document.querySelector(selector),
    csrf = () => $("input[name=_csrf]")?.value || "";
  async function request(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        Accept: "application/json",
        "X-CSRF-Token": csrf(),
        ...(options.body instanceof Blob
          ? {}
          : { "Content-Type": "application/json" }),
        ...options.headers,
      },
      redirect: "error",
    });
    let value;
    try {
      value = await response.json();
    } catch {
      throw Error("The server returned an unexpected response.");
    }
    if (!response.ok) throw Error(value.error?.message || "Request failed.");
    return value;
  }
  window.KagNodeMedia = { request, csrf };
  window.KagNodeLoginHost = {
    state: () => ({
      enabled: !!document.querySelector("[data-core-login-provider]"),
    }),
    request: (action, data) =>
      request("/api/v1/kagnode-login", {
        method: "POST",
        body: JSON.stringify({ action, ...data }),
      }),
    complete: (result) => {
      if (result.continuation !== "signed_in" || result.redirect !== "/account")
        throw Error("Invalid sign-in continuation.");
      location.assign("/account");
    },
  };
  window.KagNodeLogin?.refresh();
  const approved = new WeakSet(),
    dialog = $("[data-confirm-dialog]");
  let pending;
  document.addEventListener(
    "submit",
    (event) => {
      const form = event.target,
        button = event.submitter;
      if (form.matches("[data-upload-wizard],[data-report]")) return;
      if (button?.dataset.confirm && !approved.delete(form)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        pending = { form, button };
        $("[data-confirm-message]").textContent = button.dataset.confirm;
        dialog.showModal();
        $("[data-confirm-cancel]").focus();
      }
    },
    true,
  );
  $("[data-confirm-cancel]")?.addEventListener("click", () => dialog.close());
  $("[data-confirm-accept]")?.addEventListener("click", () => {
    const next = pending;
    dialog.close();
    approved.add(next.form);
    next.form.requestSubmit(next.button);
  });
  dialog?.addEventListener("close", () =>
    pending?.button?.focus({ preventScroll: true }),
  );
  const loading = $("[data-loading-screen]"),
    strip = $("[data-page-progress]");
  let deferred = false;
  function showLoading(text) {
    if (window.KagNodeCore) {
      window.KagNodeCore.loading.show(text);
      return;
    }
    loading.hidden = false;
    strip.hidden = false;
    $("[data-loading-label]").textContent = text;
  }
  document.addEventListener("submit", (event) => {
    if (
      event.defaultPrevented ||
      event.target.matches("[data-upload-wizard],[data-report]")
    )
      return;
    const form = event.target;
    if (form.matches("[data-policy-form]"))
      form.elements.profiles.value = JSON.stringify(
        [...form.querySelectorAll("[data-profile]")].map((row) =>
          Object.fromEntries(
            [...row.querySelectorAll("[data-profile-field]")].map((input) => [
              input.dataset.profileField,
              input.dataset.profileField === "id"
                ? input.value
                : Number(input.value),
            ]),
          ),
        ),
      );
    if (form.getAttribute("action") === "/logout" && !deferred) {
      event.preventDefault();
      deferred = true;
      showLoading("Logging out…");
      setTimeout(() => form.requestSubmit(event.submitter), 3000);
      return;
    }
    const action = form.getAttribute("action") || location.pathname;
    showLoading(
      action === "/logout"
        ? "Logging out…"
        : action === "/login"
          ? "Signing in…"
          : action === "/register"
            ? "Creating account…"
            : form.method === "get"
              ? "Loading…"
              : /remove|delete/.test(action)
                ? "Removing…"
                : /publish|submit/.test(action)
                  ? "Updating publication…"
                  : "Saving changes…",
    );
  });
  addEventListener("pageshow", () => {
    window.KagNodeCore?.loading.hide();
    if (loading) loading.hidden = true;
    if (strip) strip.hidden = true;
    deferred = false;
  });
  $("[data-favorite]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const current = button.getAttribute("aria-pressed") === "true";
      await request("/api/v1/media/" + button.dataset.favorite + "/favorite", {
        method: "POST",
        body: JSON.stringify({ favorite: !current }),
      });
      button.setAttribute("aria-pressed", String(!current));
      button.textContent = current ? "Add to favorites" : "Remove favorite";
    } catch (error) {
      button.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
  $("[data-report]")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget,
      feedback = form.querySelector("[data-report-status]");
    try {
      await request("/api/v1/media/" + form.dataset.report + "/reports", {
        method: "POST",
        body: JSON.stringify({ reason: form.elements.reason.value }),
      });
      feedback.textContent = "Report submitted.";
      form.elements.reason.value = "";
    } catch (error) {
      feedback.textContent = error.message;
    }
  });
  let zoom = 1;
  document.querySelectorAll("[data-photo-zoom]").forEach(
    (button) =>
      (button.onclick = () => {
        zoom =
          button.dataset.photoZoom === "reset"
            ? 1
            : Math.min(
                4,
                Math.max(
                  0.5,
                  zoom + (button.dataset.photoZoom === "in" ? 0.25 : -0.25),
                ),
              );
        const image = $("[data-photo]");
        image.style.width = zoom * 100 + "%";
        image.style.maxWidth = "none";
        image.style.maxHeight = zoom === 1 ? "80vh" : "none";
        window.KagNodeScroll?.refresh();
      }),
  );
  document.querySelectorAll("[data-job-action]").forEach(
    (button) =>
      (button.onclick = async () => {
        button.disabled = true;
        try {
          await request(
            "/api/v1/processing-jobs/" +
              button.dataset.job +
              "/" +
              button.dataset.jobAction,
            { method: "POST", body: "{}" },
          );
          location.reload();
        } catch (error) {
          $("[data-jobs-feedback]").textContent = error.message;
          button.disabled = false;
        }
      }),
  );
  $("[data-refresh-jobs]")?.addEventListener("click", () => location.reload());
  const wizard = $("[data-upload-wizard]");
  if (!wizard) return;
  let step = 0,
    uploadId = null,
    uploadController = null;
  const fileInput = wizard.querySelector("[data-upload-file]"),
    feedback = wizard.querySelector("[data-upload-error]");
  const showStep = (n) => {
    step = n;
    wizard
      .querySelectorAll("[data-step]")
      .forEach((box) => (box.hidden = Number(box.dataset.step) !== n));
    wizard.querySelectorAll("[data-step-label]").forEach((label) => {
      if (Number(label.dataset.stepLabel) === n)
        label.setAttribute("aria-current", "step");
      else label.removeAttribute("aria-current");
    });
    wizard.querySelector("[data-step-back]").hidden = n === 0;
    wizard.querySelector("[data-step-next]").hidden = n === 2;
    wizard.querySelector("[data-upload-start]").hidden = n !== 2;
    window.KagNodeScroll?.refresh();
  };
  const metadata = () => {
    const data = Object.fromEntries(new FormData(wizard));
    delete data._csrf;
    data.tags = String(data.tags || "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    return data;
  };
  fileInput.addEventListener("change", () => {
    const file = fileInput.files[0];
    if (!file) return;
    wizard.querySelector("[data-file-summary]").textContent =
      file.name + " · " + (file.size / 1024 ** 2).toFixed(1) + " MiB";
    const type = file.type.startsWith("image/")
      ? "image"
      : file.type.startsWith("audio/")
        ? "audio"
        : file.type.startsWith("video/")
          ? "video"
          : "file";
    wizard.elements.kind.value = type;
    wizard.elements.kind.dispatchEvent(new Event("change", { bubbles: true }));
    wizard.elements.category.value = {
      image: "photo",
      audio: "music",
      video: "video",
      file: "file",
    }[type];
    wizard.elements.category.dispatchEvent(
      new Event("change", { bubbles: true }),
    );
    if (!wizard.elements.title.value)
      wizard.elements.title.value = file.name.replace(/\.[^.]+$/, "");
  });
  wizard.querySelector("[data-step-next]").onclick = () => {
    feedback.hidden = true;
    if (step === 0 && !fileInput.reportValidity()) return;
    if (
      step === 1 &&
      ![
        ...wizard
          .querySelector('[data-step="1"]')
          .querySelectorAll("input,select,textarea"),
      ].every((e) => e.reportValidity())
    )
      return;
    showStep(Math.min(2, step + 1));
  };
  wizard.querySelector("[data-step-back]").onclick = () =>
    showStep(Math.max(0, step - 1));
  wizard.addEventListener("submit", (event) => event.preventDefault());
  const records = () => {
    try {
      return JSON.parse(
        localStorage.getItem("kagnode.media.uploads." + wizard.dataset.user) ||
          "[]",
      );
    } catch {
      return [];
    }
  };
  const saveRecord = (record) => {
    try {
      const entries = records().filter((r) => r.id !== record.id);
      if (!record.complete) entries.push(record);
      localStorage.setItem(
        "kagnode.media.uploads." + wizard.dataset.user,
        JSON.stringify(entries.slice(-10)),
      );
    } catch {}
  };
  wizard.querySelector("[data-upload-start]").onclick = async () => {
    const file = fileInput.files[0],
      button = wizard.querySelector("[data-upload-start]"),
      cancel = wizard.querySelector("[data-upload-cancel]"),
      status = wizard.querySelector("[data-upload-status]"),
      bar = wizard.querySelector("[data-upload-progress]");
    if (!file) return;
    button.disabled = true;
    feedback.hidden = true;
    cancel.hidden = false;
    uploadController = new AbortController();
    try {
      const previous = records().find(
        (r) =>
          r.name === file.name &&
          r.size === file.size &&
          r.modified === file.lastModified,
      );
      let upload;
      if (previous) {
        try {
          upload = await request("/api/v1/uploads/" + previous.id);
        } catch {}
      }
      if (!upload || !["open", "finalizing"].includes(upload.state))
        upload = await request("/api/v1/uploads", {
          method: "POST",
          body: JSON.stringify({
            filename: file.name,
            size: file.size,
            metadata: metadata(),
          }),
        });
      uploadId = upload.id;
      saveRecord({
        id: upload.id,
        name: file.name,
        size: file.size,
        modified: file.lastModified,
      });
      let offset = upload.offset;
      while (offset < file.size) {
        const end = Math.min(file.size, offset + upload.maxChunk),
          chunk = file.slice(offset, end);
        const result = await request("/api/v1/uploads/" + upload.id, {
          method: "PUT",
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Range": `bytes ${offset}-${end - 1}/${file.size}`,
          },
          body: chunk,
          signal: uploadController.signal,
        });
        offset = result.offset;
        bar.value = (offset / file.size) * 100;
        status.textContent = "Uploaded " + Math.round(bar.value) + "%";
      }
      status.textContent = "Finalizing the upload…";
      const result = await request(
        "/api/v1/uploads/" + upload.id + "/complete",
        { method: "POST", body: "{}", signal: uploadController.signal },
      );
      saveRecord({ id: upload.id, complete: true });
      status.textContent = "Upload saved. Processing is queued.";
      const link = wizard.querySelector("[data-upload-result]");
      link.href = "/creator/media/" + result.id;
      link.hidden = false;
      cancel.hidden = true;
    } catch (error) {
      feedback.textContent =
        error.name === "AbortError"
          ? "Upload paused. Select the same file and resume."
          : error.message;
      feedback.hidden = false;
      status.textContent = "Upload paused. Saved chunks are retained.";
    } finally {
      button.disabled = false;
    }
  };
  wizard.querySelector("[data-upload-cancel]").onclick = async () => {
    uploadController?.abort();
    if (uploadId) {
      try {
        await request("/api/v1/uploads/" + uploadId, { method: "DELETE" });
        saveRecord({ id: uploadId, complete: true });
        wizard.querySelector("[data-upload-status]").textContent =
          "Upload cancelled.";
      } catch (error) {
        feedback.textContent = error.message;
        feedback.hidden = false;
      }
    }
  };
})();
