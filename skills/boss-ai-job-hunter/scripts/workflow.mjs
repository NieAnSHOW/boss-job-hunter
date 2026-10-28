export function contactedJobIds(state) {
  return new Set((state.greeted || [])
    .filter((record) => record.ok === true || record.note === "已是沟通中")
    .map((record) => record.jobId));
}

export function isSelectable(job, cfg, contacted = new Set()) {
  return typeof job.jobId === "string" && job.jobId.length > 0
    && Number.isSafeInteger(job.reviewIndex) && job.reviewIndex > 0
    && typeof job.href === "string" && /^\/job_detail\/[^/]+\.html(?:\?[^#]*)?$/.test(job.href)
    && job.prefilter === true && !job.rejectReason && !job.detailFailed
    && typeof job.desc === "string" && job.desc.trim().length > 0
    && Number.isFinite(job.score)
    && job.city === cfg.city.name
    && job.salary?.monthly === true && Number.isFinite(job.salary.min)
    && job.salary.min >= cfg.salaryMinK
    && !job.alreadyGreeted && !contacted.has(job.jobId);
}
