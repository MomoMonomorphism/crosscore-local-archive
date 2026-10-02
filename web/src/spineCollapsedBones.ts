import type { Skeleton } from '@esotericsoftware/spine-core'

/** A fully collapsed parent has no inverse. Keep the finite local transform
 * computed earlier this frame instead of decomposing 0/0 after a constraint.
 * Only exact, fully collapsed world matrices qualify; visible and partially
 * scaled bones continue through the original runtime unchanged.
 */
export function preserveCollapsedBoneTransforms(skeleton: Skeleton) {
  for (const bone of skeleton.bones) {
    if (!bone.parent) continue
    const updateAppliedTransform = bone.updateAppliedTransform
    bone.updateAppliedTransform = function () {
      const parent = this.parent!
      if (parent.a === 0 && parent.b === 0 && parent.c === 0 && parent.d === 0
        && this.a === 0 && this.b === 0 && this.c === 0 && this.d === 0
        && Number.isFinite(this.worldX) && Number.isFinite(this.worldY)
        && [this.ax, this.ay, this.arotation, this.ascaleX, this.ascaleY,
          this.ashearX, this.ashearY].every(Number.isFinite)) return
      updateAppliedTransform.call(this)
    }
  }
}
