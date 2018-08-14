#define _CRT_SECURE_NO_WARNINGS
#include <stdio.h>
// MAX : 100,000

int main() {
	int n, k, coin[100], d[10001] = { 0 };


	scanf("%d %d", &n, &k);

	d[0] = 1;
	for (int i = 0; i < n; i++) {
		scanf("%d", coin + i);
	}


	// DP
	int val = 0;
	for (int c = 0; c < n; c++) {
		val = coin[c];
		/*printf("%d : ", val);
		for (int i = 1; i < val; i++)
			printf("%d ",d[i]);*/
		for (int i = val; i <= k; i++) {
			d[i] += d[i - val] ;
			//printf("%d ", d[i]);
		}
		//printf("\n");
	}
	printf("%d", d[k]);

//	system("pause");
	return 0;
}