# Arguments: original survey CSV, and one Development ResponseID per line.
# The browser check compares the stored membership digest to the live split.
args <- commandArgs(TRUE)
survey <- read.csv(args[1])
ids <- scan(args[2], integer(), quiet=TRUE)
stopifnot(length(ids) == 1050, !anyDuplicated(ids), all(ids %in% survey$ResponseID))
items <- c("Plan", "Explore", "Organize", "Imagine", "Schedule", "Invent", "Prepare", "Experiment")
rows <- match(ids, survey$ResponseID)
x <- survey[rows, items]
stopifnot(all(complete.cases(x)))
r <- diag(length(items))
for (i in seq_len(ncol(x) - 1)) for (j in (i + 1):ncol(x)) {
  r[i,j] <- r[j,i] <- polycor::polychor(x[[i]], x[[j]], ML=FALSE, maxcor=.9999)
}
fit <- psych::fa(r, nfactors=2, fm="minres", rotate="none", SMC=TRUE, smooth=FALSE)
rot <- stats::promax(unclass(fit$loadings), m=4)
pattern <- unclass(rot$loadings)
inverse <- solve(rot$rotmat)
weights <- solve(r, pattern %*% inverse %*% t(inverse))
membership <- tempfile()
writeBin(charToRaw(as.character(jsonlite::toJSON(rows - 1L))), membership)
digest <- function(path) strsplit(system2("sha256sum", shQuote(path), stdout=TRUE), " ")[[1]][1]
cat(jsonlite::toJSON(list(items=items, seed=2026L, fraction=.7, nRows=nrow(x),
  inputSha256=digest(args[1]), membershipSha256=digest(membership),
  R=R.version.string, packages=lapply(c(polycor="polycor", psych="psych"), function(p) as.character(packageVersion(p))),
  pattern=pattern, weights=weights), digits=16, pretty=TRUE, auto_unbox=TRUE), "\n", sep="")
