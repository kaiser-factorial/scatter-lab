# Scatter Lab conditional Gaussian completion replay
# Usage: Rscript replay-completion.R operation.json completed.csv
# Dependency: jsonlite. Uses the saved fitted parameters, not a new lavaan fit.
# Expected values are predictions; this operation adds no imputation uncertainty.
args <- commandArgs(trailingOnly = TRUE)
stopifnot(length(args) == 2L)
op <- jsonlite::read_json(args[[1]], simplifyVector = FALSE)
stopifnot(identical(op$format, "scatterlab-conditional-completion/1"))
num <- function(x) if (is.null(x) || identical(x, "")) NA_real_ else as.numeric(x)
rows <- function(x) do.call(rbind, lapply(x, function(row) vapply(row, num, numeric(1))))
input <- rows(op$input)
mu <- unlist(op$model$means)
Sigma <- rows(op$model$covariance)
offsets <- vapply(op$model$reverseOffsets, num, numeric(1))
output <- input
stopifnot(ncol(input) == length(mu), all(dim(Sigma) == length(mu)))
for (i in seq_len(nrow(input))) {
  observed <- which(!is.na(input[i, ]))
  missing <- which(is.na(input[i, ]))
  if (!length(observed) || !length(missing)) next
  values <- input[i, ]
  reverse <- which(!is.na(offsets))
  values[reverse] <- offsets[reverse] - values[reverse]
  solved <- solve(Sigma[observed, observed, drop = FALSE], values[observed] - mu[observed])
  predicted <- mu[missing] + as.vector(Sigma[missing, observed, drop = FALSE] %*% solved)
  reversed <- !is.na(offsets[missing])
  predicted[reversed] <- offsets[missing][reversed] - predicted[reversed]
  output[i, missing] <- predicted
}
colnames(output) <- unlist(op$columns)
result <- data.frame(source_row = unlist(op$rows) + 1L, output, check.names = FALSE)
write.csv(result, args[[2]], row.names = FALSE, na = "")
