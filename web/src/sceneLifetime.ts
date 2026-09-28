type SceneObject = {
  destroyed: boolean
  destroy(options: { children: boolean; texture: boolean; baseTexture: boolean }): void
}

/** Own objects before they reach the stage, including across asynchronous loads.
 * Shared Assets textures belong to the asset cache, not to an individual scene. */
export function createSceneLifetime() {
  let disposed = false
  const objects = new Set<SceneObject>()
  return {
    create<T extends SceneObject>(factory: () => T): T {
      if (disposed) throw new Error('Scene was disposed during loading')
      const object = factory()
      objects.add(object)
      return object
    },
    dispose() {
      disposed = true
      for (const object of objects) {
        if (!object.destroyed) object.destroy({ children: true, texture: false, baseTexture: false })
      }
      objects.clear()
    },
  }
}
