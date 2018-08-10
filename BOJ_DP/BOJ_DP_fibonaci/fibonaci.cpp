#define _CRT_SECURE_NO_WARNINGS
#include <stdio.h>
/*	f(0) = 0
	f(1) = 1
	f(n) = f(n-1) +f(n-2) (n > 1 )
*/
int main() {
	int T,k;
	int d[41];
	int cnt[2][41];
	d[0] = 0; d[1] = 1; 
	cnt[0][0] = 1; cnt[0][1] = 0;
	cnt[1][0] = 0; cnt[1][1] = 1;
	
	for (int i = 2; i <= 40; i++) {
		d[ i ] = d[i - 1] + d[i - 2];
		cnt[0][i] = cnt[0][i - 1] + cnt[0][i - 2];
		cnt[1][i] = cnt[1][i - 1] + cnt[1][i - 2];
	}

	scanf("%d", &T);
	for (int t = 0; t < T; t++) {
		scanf("%d", &k);
		printf("%d %d\n", cnt[0][k], cnt[1][k]);
	}
	return 0;
}
