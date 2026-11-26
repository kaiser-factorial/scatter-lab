library(lavaan); library(polycor); library(jsonlite)
out <- if(length(commandArgs(TRUE))) commandArgs(TRUE)[1] else "/out"
dir.create(out, recursive=TRUE, showWarnings=FALSE)
file.copy("/opt/efa/weighted-installed.json",file.path(out,"runtime.json"),overwrite=TRUE)
options(warn=1)
set.seed(75131)

# Independent R scores and matrix inversion. Native code instead evaluates
# response-cell derivatives and the closed-form inverse of marginal sensitivity.
pair_moments <- function(x) {
  n <- nrow(x); p <- ncol(x); r <- diag(p); S <- matrix(0,n,p*(p-1)/2)
  pairs <- list(); a <- 0L
  for(i in seq_len(p-1)) for(j in (i+1):p) {
    a <- a+1L; ok <- complete.cases(x[,c(i,j)]); y <- x[ok,c(i,j),drop=FALSE]
    y[,1] <- match(y[,1],sort(unique(y[,1]))); y[,2] <- match(y[,2],sort(unique(y[,2])))
    levels <- apply(y,2,max); nt <- sum(levels-1L)
    base <- lavaan:::muthen1984(Data=y,ov.names=colnames(y),ov.types=rep("ordered",2),ov.levels=levels,zero.add=c(0,0),allow.empty.cell=FALSE)
    rho <- polycor::polychor(y[,1],y[,2],ML=FALSE,maxcor=.9999)
    sc <- lavaan:::lav_bvord_cor_scores(Y1=y[,1],Y2=y[,2],rho=rho)
    stopifnot(all(is.finite(sc$dx.rho)),all(is.finite(sc$dx.th.y1)),all(is.finite(sc$dx.th.y2)))
    a21 <- crossprod(sc$dx.rho,cbind(sc$dx.th.y1,sc$dx.th.y2)); a22 <- drop(crossprod(sc$dx.rho))
    coeff <- c(-solve(base$A11,t(a21))/a22,1/a22)
    s <- n * drop(cbind(base$SC[,seq_len(nt),drop=FALSE],sc$dx.rho)%*%coeff)
    S[ok,a] <- s; r[i,j] <- r[j,i] <- rho
    pairs[[a]] <- list(i=i-1L,j=j-1L,n=sum(ok),rho=rho,variance=sum(s*s)/n)
  }
  list(correlation=r,gamma=crossprod(S)/n,scores=S,pairs=pairs)
}

# An independent full rotation delta map also covers structure/communality
# errors and Promax, which lavaan does not expose as free-parameter SEs.
rotation_delta <- function(est,gamma,n) {
  common <- est$lambda%*%est$psi%*%t(est$lambda);e <- eigen(common,symmetric=TRUE)
  A <- sweep(e$vectors[,1:2,drop=FALSE],2,sqrt(e$values[1:2]),"*")
  anchors <- qr(t(A),LAPACK=TRUE)$pivot[1:2]
  Q <- qr.Q(qr(t(A[anchors,,drop=FALSE])));A <- A%*%Q;A[anchors[1],2] <- 0
  free <- which(matrix(TRUE,nrow(A),2),arr.ind=TRUE);free <- free[!(free[,1]==anchors[1]&free[,2]==2),,drop=FALSE]
  unpack <- function(v){L<-A;L[free]<-v;L}
  theta <- A[free]
  J <- numDeriv::jacobian(function(v){model<-tcrossprod(unpack(v));model[lower.tri(model)]},theta)
  W <- diag(1/diag(gamma));G <- solve(t(J)%*%W%*%J)
  covariance <- G%*%t(J)%*%W%*%gamma%*%W%*%J%*%G/(n-1)
  result <- list()
  for(method in c("oblimin","varimax","promax")) {
    rotation <- function(v){
      L <- unpack(v)
      if(method=="oblimin") {
        r<-GPArotation::oblimin(L,gam=0,normalize=FALSE,eps=1e-8,maxit=10000)
        stopifnot(r$convergence);pattern<-unclass(r$loadings);phi<-r$Phi
      } else {
        r<-stats::varimax(L,normalize=TRUE,eps=1e-14);pattern<-unclass(r$loadings);phi<-diag(2)
        if(method=="promax") {
          target<-pattern*abs(pattern)^3;U<-solve(crossprod(pattern),crossprod(pattern,target));U<-sweep(U,2,sqrt(diag(solve(crossprod(U)))),"*")
          pattern<-pattern%*%U;transform<-r$rotmat%*%U;phi<-solve(transform)%*%t(solve(transform))
        }
      }
      list(pattern=pattern,phi=phi)
    }
    baseline<-rotation(theta)
    values<-function(v){
      r<-rotation(v);cong<-crossprod(baseline$pattern,r$pattern)/sqrt(outer(colSums(baseline$pattern^2),colSums(r$pattern^2)))
      order<-if(sum(abs(diag(cong)))>=sum(abs(cong[cbind(1:2,2:1)])))1:2 else 2:1;signs<-ifelse(cong[cbind(1:2,order)]<0,-1,1)
      pattern<-sweep(r$pattern[,order,drop=FALSE],2,signs,"*");phi<-r$phi[order,order]*outer(signs,signs);structure<-pattern%*%phi
      c(as.vector(t(pattern)),as.vector(t(structure)),as.vector(t(phi)),rowSums(unpack(v)^2))
    }
    scale <- 1+abs(theta)
    derivative<-numDeriv::jacobian(function(offset)values(theta+offset*scale),rep(0,length(theta)),method="Richardson",method.args=list(d=.004,eps=.004,r=3))
    derivative<-sweep(derivative,2,scale,"/")
    se<-sqrt(diag(derivative%*%covariance%*%t(derivative)));p<-nrow(A)
    result[[method]]<-list(pattern=baseline$pattern,phi=baseline$phi,structure=baseline$pattern%*%baseline$phi,se=list(pattern=matrix(se[seq_len(p*2)],p,2,byrow=TRUE),structure=matrix(se[p*2+seq_len(p*2)],p,2,byrow=TRUE),phi=matrix(se[p*4+1:4],2,2,byrow=TRUE),communalities=tail(se,p)),method="Independent R numDeriv Richardson r=3 eps=.004 on offsets scaled by 1+abs(theta); QR orientation; full GPArotation/stats rotation map; varimax eps=1e-14; N-1 denominator")
  }
  result
}

cases <- list()
for(name in c("normal","heavy-tail","skew","pairwise","complete")) {
  case.seed <- 75130L+match(name,c("normal","heavy-tail","skew","pairwise","complete"));set.seed(case.seed)
  n <- 1000L; p <- 8L
  draw <- switch(name,"heavy-tail"=function(n)rt(n,5)/sqrt(5/3),skew=function(n)(rlnorm(n,0,.6)-exp(.18))/sqrt((exp(.36)-1)*exp(.36)),function(n)rnorm(n))
  f <- cbind(draw(n),draw(n)); f[,2] <- .3*f[,1]+sqrt(1-.3^2)*f[,2]
  lambda <- cbind(c(.75,.7,.65,.6,.1,.15,.05,.12),c(.05,.1,.15,.1,.7,.75,.65,.6))
  h2 <- diag(lambda%*%matrix(c(1,.3,.3,1),2)%*%t(lambda))
  y <- f%*%t(lambda)+matrix(draw(n*p),n,p)%*%diag(sqrt(1-h2))
  levels <- c(2L,3L,4L,5L,7L,5L,3L,2L)
  x <- sapply(seq_len(p),function(j)as.integer(cut(y[,j],c(-Inf,qnorm(seq_len(levels[j]-1)/levels[j]),Inf),labels=FALSE)))
  colnames(x) <- paste0("Q",seq_len(p))
  if(name %in% c("pairwise","complete")) x[matrix(runif(n*p)<.1,n,p)] <- NA
  # A recorded reverse-key transformation; source values remain original.
  reverse <- c(2L,5L); source <- x
  x[,reverse] <- sweep(x[,reverse,drop=FALSE],2,levels[reverse]+1,function(a,b)b-a)
  rows <- if(name=="complete")which(complete.cases(x)) else seq_len(n)
  x <- x[rows,,drop=FALSE]; moments <- pair_moments(x)
  dimnames(moments$correlation) <- list(colnames(x),colnames(x))
  # Native pairs (i,j), i<j, match column-major lower-triangle lavaan order.
  fits <- list();default.standardization <- list()
  for(rotation in c("oblimin","varimax")) {
    fit <- efa(sample.cov=moments$correlation,sample.nobs=nrow(x),nfactors=2,correlation=TRUE,estimator="DWLS",WLS.V=diag(1/diag(moments$gamma)),NACOV=moments$gamma,se="robust.sem",test="scaled.shifted",rotation=rotation,rotation.args=list(rstarts=10,row.weights=if(rotation=="varimax")"kaiser" else "none"),bounds="none",std.lv=TRUE,sample.cov.rescale=FALSE,output="lavaan")
    stopifnot(lavInspect(fit,"converged"))
    default.standardization[[rotation]] <- list(est=lavInspect(fit,"est"),se=lavInspect(fit,"se"),settings=lavInspect(fit,"options")$rotation.args)
    fit <- efa(sample.cov=moments$correlation,sample.nobs=nrow(x),nfactors=2,correlation=TRUE,estimator="DWLS",WLS.V=diag(1/diag(moments$gamma)),NACOV=moments$gamma,se="robust.sem",test="scaled.shifted",rotation=rotation,rotation.args=list(rstarts=10,row.weights=if(rotation=="varimax")"kaiser" else "none",std.ov=FALSE),bounds="none",std.lv=TRUE,sample.cov.rescale=FALSE,output="lavaan")
    stopifnot(lavInspect(fit,"converged"))
    fits[[rotation]] <- list(est=lavInspect(fit,"est"),se=lavInspect(fit,"se"),test=lavInspect(fit,"test"),reproduced=fitted(fit)$cov,parameterEstimates=parameterEstimates(fit),settings=lavInspect(fit,"options")$rotation.args)
  }
  raw <- NULL
  delta <- rotation_delta(fits$oblimin$est,moments$gamma,nrow(x))
  if(!anyNA(x)) {
    full <- lavaan:::muthen1984(Data=x,ov.names=colnames(x),ov.types=rep("ordered",p),ov.levels=levels,zero.add=c(0,0),allow.empty.cell=FALSE)
    raw <- list(correlation=full$COR,gamma=tail(seq_len(nrow(full$WLS.W)),p*(p-1)/2))
    raw$gamma <- full$WLS.W[raw$gamma,raw$gamma]*nrow(x)
  }
  input <- list(columns=colnames(source),data=as.list(as.data.frame(source)),nRows=n,categories=lapply(levels,seq_len),reverse=reverse-1L,missing=if(name=="complete")"complete" else "pairwise",nFactors=2L)
  write_json(input,file.path(out,paste0(name,".input.json")),auto_unbox=TRUE,digits=17,na="null",pretty=TRUE)
  write_json(list(provenance=list(R=R.version.string,lavaan=as.character(packageVersion("lavaan")),polycor=as.character(packageVersion("polycor")),seed=case.seed,scope="pair-margin polycor moments; independent lavaan scores and matrix inversion; supplied-moment DWLS plus robust scaled/shifted test; no zero-cell correction; unconstrained uniquenesses; rotation std.ov=FALSE on already standardized correlation scale",rotationStandardization="Default lavaan std.ov=TRUE outputs are retained separately. Point rotation is unchanged on a unit-diagonal model, but its bordered SE calculation gives different results for oblique rotations. Native uses the full loading-to-rotation map without an additional observed-variable rescaling."),rows=rows-1L,correlation=unname(moments$correlation),gamma=unname(moments$gamma),pairs=moments$pairs,scoreRows=unname(moments$scores[seq_len(12),,drop=FALSE]),fits=fits,delta=delta,defaultRotationStandardization=default.standardization,raw=raw),file.path(out,paste0(name,".reference.json")),auto_unbox=TRUE,digits=17,na="null",null="null",pretty=TRUE)
}
