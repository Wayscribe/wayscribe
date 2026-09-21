export interface OwnedTestResource {
  name: string;
  close: () => void | Promise<void>;
}

export async function closeOwnedTestResources(
  resources: readonly (OwnedTestResource | undefined)[]
): Promise<void> {
  const failures: Error[] = [];
  for (const resource of resources) {
    if (resource === undefined) continue;
    try {
      await resource.close();
    } catch (cause) {
      failures.push(new Error(`Failed to close ${resource.name}`, { cause }));
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Failed to close owned test resources");
  }
}
