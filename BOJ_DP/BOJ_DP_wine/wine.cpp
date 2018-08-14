#define _CRT_SECURE_NO_WARNINGS
#include <stdio.h>

#define MAX(x,y) (x)>=(y) ?  (x) : (y)

int main(){
	// get input
	int n, wine[10001], dp[10001];
	scanf("%d", &n);
	for (int i = 1; i <= n; i++) {
		scanf("%d", wine + i);
	}
	// dp
	dp[0] = 0;
	dp[1] = wine[1];
	dp[2] = wine[1] + wine[2];
	//printf("%d %d ", dp[1], dp[2]);
	for (int i = 3; i <= n; i++) {
		if (dp[i - 1] == dp[i - 2]) {
			dp[i] = dp[i - 1] + wine[i];
			//printf("(%d) ", dp[i]);
		}
		else {
			dp[i] = MAX(MAX(dp[i-2] + wine[i], dp[i-1]), dp[i-3]+wine[i-1]+wine[i]);
			//printf("%d ", dp[i]);
		}
	}
	// print result
	printf("%d", dp[n]); 

	return 0;
}