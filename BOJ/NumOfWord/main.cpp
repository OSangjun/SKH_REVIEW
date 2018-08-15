#define _CRT_SECURE_NO_WARNINGS
#include <stdio.h>
#include <stdlib.h>
int main() {

	int num = 0;
	char ch, last;
	
	last = getchar();
	while (  (ch = getchar()) != '\n' ) {
		if (ch == ' ' && last != ' ') {
			num++;
		}
		last = ch;
	}

	printf("%d ", num+1);
	system("pause");

	return 0;
}