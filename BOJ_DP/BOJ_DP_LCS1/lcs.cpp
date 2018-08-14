#define _CRT_SECURE_NO_WARNINGS
#include <stdio.h>
#define MAX(x,y) (x)>=(y) ? (x):(y)
char str0[1001], str1[1001];
int table[1001][1001];
int len0, len1, last1 = -1, last0 = -1;

int main() {
	// get input
	fflush(stdin);
	scanf("%s", str0);
	fflush(stdin);
	scanf("%s", str1);

	// init
	len0 = 0; len1 = 0;
	for (int i = 0; i < 1000; i++) {
		table[0][i + 1] = 0;
		table[i + 1][0] = 0;
		if (str0[i] == NULL && !len0 ) {
			len0 = i;
		}
		if (str1[i] == NULL && !len1) {
			len1 = i;
		}
	}
	// make table
	int tmp, hit;
	for (int i = 1; i <= len1; i++) {
		for (int j = 1; j <= len0; j++) {
			hit = (str1[i-1] == str0[j-1]);
			if (hit) {
				table[i][j] = table[i-1][j-1]+1;
			}
			else {
				table[i][j] = MAX(table[i][j - 1], table[i - 1][j]);
			}
			//printf("%d", table[i][j]);
		}
		//printf("\n");
	}

	// print result.
	printf("%d", table[len1][len0]);

	return 0;
}