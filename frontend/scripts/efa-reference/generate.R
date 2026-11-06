library(polycor)
library(psych)
library(GPArotation)
library(jsonlite)
out <- if (length(commandArgs(TRUE))) commandArgs(TRUE)[1] else "/out"
dir.create(out, recursive=TRUE, showWarnings=FALSE)
versions <- sapply(c("polycor", "psych", "GPArotation", "mvtnorm", "mnormt", "admisc", "jsonlite"), function(x) as.character(packageVersion(x)))
set.seed(73021)
make_data <- function(n, p, binary=FALSE, skew=FALSE) {
  k <- 2L
  phi <- matrix(c(1, .35, .35, 1), k)
  f <- matrix(rnorm(n*k), n, k) %*% chol(phi)
  l <- matrix(.08, p, k)
  l[cbind(seq_len(p), rep(1:2, length.out=p))] <- .65
  l[3,2] <- .25
  z <- f %*% t(l) + sweep(matrix(rnorm(n*p), n, p), 2, sqrt(1-diag(l%*%phi%*%t(l))), "*")
  x <- sapply(seq_len(p), function(j) {
    cuts <- if(binary) 0 else if(skew) c(-.2,.5,1,1.7) else if(j %% 3 == 0) c(-.7,.6) else c(-1,-.3,.4,1.1)
    as.integer(cut(z[,j], c(-Inf,cuts,Inf), labels=FALSE))
  })
  colnames(x) <- paste0("item", seq_len(p))
  x
}
run_fixture <- function(name, x, missing="pairwise", reverse=integer()) {
  raw <- x
  categories <- lapply(seq_len(ncol(x)), function(i) sort(unique(na.omit(x[,i]))))
  for (j in reverse) x[,j] <- length(categories[[j]]) + 1 - x[,j]
  rows <- if(missing == "complete") which(complete.cases(x)) else seq_len(nrow(x))
  xfit <- x[rows,,drop=FALSE]
  p <- ncol(x)
  r <- diag(p); pairs <- list()
  for(i in seq_len(p-1)) for(j in (i+1):p) {
    valid <- complete.cases(xfit[,c(i,j)])
    z <- polychor(xfit[valid,i], xfit[valid,j], ML=FALSE, maxcor=.9999, thresholds=TRUE)
    r[i,j] <- r[j,i] <- z$rho
    pairs[[length(pairs)+1]] <- list(i=i-1L,j=j-1L,n=sum(valid),rho=z$rho,thresholdsX=z$row.cuts,thresholdsY=z$col.cuts)
  }
  fit <- fa(r, nfactors=2, fm="minres", rotate="none", SMC=TRUE, smooth=FALSE)
  a <- unclass(fit$loadings)
  rotations <- list()
  for(method in c("oblimin","varimax","promax")) {
    rot <- switch(method, oblimin=GPArotation::oblimin(a, gam=0, normalize=FALSE, eps=1e-7, maxit=10000),
                  varimax=stats::varimax(a, normalize=TRUE, eps=1e-9), promax=stats::promax(a, m=4))
    if(method=="oblimin") stopifnot(rot$convergence)
    l <- unclass(rot$loadings)
    phi <- if(method=="oblimin") rot$Phi else if(method=="promax") solve(rot$rotmat)%*%t(solve(rot$rotmat)) else diag(2)
    structure <- l%*%phi
    model <- structure%*%t(l)
    means <- colMeans(xfit, na.rm=TRUE)
    sds <- apply(xfit,2,sd,na.rm=TRUE)
    weights <- solve(r,structure)
    z <- sweep(sweep(xfit,2,means,"-"),2,sds,"/")
    scores <- z%*%weights
    complete <- which(complete.cases(scores))
    standardized <- scale(scores[complete,,drop=FALSE])
    rotations[[method]] <- list(pattern=l,structure=structure,phi=phi,communalities=diag(model),
      reproduced=model,weights=weights,scoreRows=rows[complete]-1L,standardizedScores=standardized)
  }
  input <- list(columns=colnames(raw),data=as.list(as.data.frame(raw)),nRows=nrow(raw),categories=categories,
                reverse=reverse-1L,missing=missing,nFactors=2L)
  input_path <- file.path(out,paste0(name,".input.json"))
  write_json(input,input_path,auto_unbox=TRUE,na="null",digits=17,pretty=TRUE)
  hash <- strsplit(system2("sha256sum", shQuote(input_path), stdout=TRUE), " ")[[1]][1]
  result <- list(name=name,provenance=list(R=R.version.string,packages=as.list(versions),seed=73021L,inputSha256=hash,
    settings=list(polychor=list(ML=FALSE,maxcor=.9999,std.err=FALSE),minres=list(SMC=TRUE,lower=.005,upper=1,smooth=FALSE),
    oblimin=list(gam=0,normalize=FALSE,eps=1e-7,converged=TRUE),varimax=list(normalize=TRUE,eps=1e-9),promax=list(power=4))),
    fittingRows=rows-1L,correlation=r,pairs=pairs,unrotated=a,rotations=rotations)
  write_json(result,file.path(out,paste0(name,".reference.json")),auto_unbox=TRUE,na="null",digits=17,pretty=TRUE)
}
x <- make_data(1500,8)
run_fixture("mixed",x)
run_fixture("binary",make_data(2000,8,binary=TRUE))
x <- make_data(1600,8,skew=TRUE)
x[sample(length(x), floor(length(x)*.06))] <- NA
run_fixture("skew-pairwise",x,reverse=c(2L,6L))
run_fixture("skew-complete",x,missing="complete",reverse=c(2L,6L))
# Public data distributed with psych: no participant data from this workspace.
data(bfi, package="psych")
run_fixture("public-bfi",as.matrix(bfi[1:1200,c("A1","A2","A3","A4","A5","C1","C2","C3","C4","C5")]), reverse=c(1L,9L,10L))

# Save actual null datasets: a shared seed is not a cross-language RNG contract.
set.seed(9912)
observed <- make_data(600,8)
parallel_case <- function(x) {
  p <- ncol(x); r <- diag(p)
  for(i in seq_len(p-1)) for(j in (i+1):p) r[i,j] <- r[j,i] <- polychor(x[,i],x[,j],ML=FALSE,maxcor=.9999)
  one <- fa(r,nfactors=1,fm="minres",rotate="none",SMC=TRUE,smooth=FALSE)
  reduced <- r; diag(reduced) <- rowSums(unclass(one$loadings)^2)
  list(table=list(columns=colnames(x),data=as.list(as.data.frame(x)),nRows=nrow(x)),correlation=r,eigenvalues=eigen(reduced,symmetric=TRUE,only.values=TRUE)$values)
}
null <- lapply(1:4,function(i) parallel_case(apply(observed,2,sample)))
write_json(list(provenance=list(R=R.version.string,packages=as.list(versions)),seed=9912,observed=parallel_case(observed),null=null,convention="one-factor MINRES communalities; saved null tables"),file.path(out,"parallel.reference.json"),auto_unbox=TRUE,na="null",digits=17,pretty=TRUE)
