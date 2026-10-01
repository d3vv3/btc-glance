export async function activePushRegistration(serviceWorker: ServiceWorkerContainer, timeoutMs = 10000): Promise<ServiceWorkerRegistration> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const existing = await serviceWorker.getRegistration();
        const registration = existing?.active ? existing : await serviceWorker.ready;
        if (!registration.active) throw new Error("Notification service is not ready. Try connecting again.");
        return registration;
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Notification service is still starting. Try connecting again shortly.")), timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}
